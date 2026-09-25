import 'server-only';
import { CanonicalMarketDetailSchema, CanonicalMarketPageSchema,
  type CanonicalMarketQuery } from '@/domain/market-api-v2';
import { StockMarketDetailSchema, StockMarketPageSchema, type StockMarketQuery } from '@/domain/stocks';

const MAX_RESPONSE_BYTES = 1_500_000;
const READ_TIMEOUT_MS = 15_000;
const DEDUPE_MS = 5_000;
const MAX_CACHE_ENTRIES = 64;

type RemoteValue = ReturnType<typeof CanonicalMarketPageSchema.parse>
  | ReturnType<typeof CanonicalMarketDetailSchema.parse>
  | ReturnType<typeof StockMarketPageSchema.parse>
  | ReturnType<typeof StockMarketDetailSchema.parse>;
type CachedRead = { expiresAt: number; promise: Promise<RemoteValue> };
const reads = new Map<string, CachedRead>();

/** A server-only, fixed-origin reader. Browser inputs can select only the
 * validated canonical page/detail contracts, never an arbitrary upstream URL. */
export function marketV2WriterOrigin(raw = process.env.MARKET_V2_WRITER_ORIGIN): string | null {
  if (!raw) return null;
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('Canonical market writer origin must use HTTPS.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Canonical market writer origin must be a bare origin.');
  }
  if (process.env.APP_ORIGIN && url.origin === new URL(process.env.APP_ORIGIN).origin) {
    throw new Error('Canonical market writer origin must not point to this website.');
  }
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('Canonical market writer response unavailable.');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Canonical market writer response too large.');
  if (!response.body) throw new Error('Canonical market writer returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Canonical market writer response too large.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchRemote<T extends RemoteValue>(key: string, url: URL,
  schema: { parse: (value: unknown) => T }, fetcher: typeof fetch): Promise<T> {
  const now = Date.now();
  for (const [entryKey, entry] of reads) if (entry.expiresAt <= now) reads.delete(entryKey);
  const cached = reads.get(key);
  if (cached && cached.expiresAt > now) return cached.promise as Promise<T>;
  const promise = (async () => {
    const response = await fetcher(url, {
      method: 'GET', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', 'X-PositionLayer-Market-Hop': '1' },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return schema.parse(await boundedJson(response));
  })();
  reads.set(key, { expiresAt: now + DEDUPE_MS, promise });
  if (reads.size > MAX_CACHE_ENTRIES) reads.delete(reads.keys().next().value!);
  try { return await promise; }
  catch (error) { if (reads.get(key)?.promise === promise) reads.delete(key); throw error; }
}

export async function readRemoteCanonicalPage(origin: string, query: CanonicalMarketQuery,
  fetcher: typeof fetch = fetch) {
  const url = new URL('/api/markets/v2/stocks', origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return fetchRemote(`page:${url.href}`, url, CanonicalMarketPageSchema, fetcher);
}

export async function readRemoteCanonicalDetail(origin: string, assetId: string,
  fetcher: typeof fetch = fetch) {
  const url = new URL(`/api/markets/v2/assets/${encodeURIComponent(assetId)}`, origin);
  return fetchRemote(`detail:${url.href}`, url, CanonicalMarketDetailSchema, fetcher);
}

/** The approved legacy Stocks view reads the same persistent host in a split
 * deployment. A Vercel reader never starts its own 300-mint market worker. */
export async function readRemoteLegacyPage(origin: string, query: StockMarketQuery,
  fetcher: typeof fetch = fetch) {
  const url = new URL('/api/markets/stocks', origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return fetchRemote(`legacy-page:${url.href}`, url, StockMarketPageSchema, fetcher);
}

export async function readRemoteLegacyDetail(origin: string, mint: string,
  fetcher: typeof fetch = fetch) {
  const url = new URL(`/api/markets/stocks/${encodeURIComponent(mint)}`, origin);
  return fetchRemote(`legacy-detail:${url.href}`, url, StockMarketDetailSchema, fetcher);
}
