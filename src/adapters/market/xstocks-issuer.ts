import 'server-only';
import { z } from 'zod';
import { XstockAssetSchema, normalizeStockUniverse } from './stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { ProviderCandidateSchema, type ProviderCandidate, type ProviderIssue } from '@/domain/market-provider';
import { MarketProviderCache, MarketProviderError, type ProviderLoad } from './provider-cache';

const BASE_URL = 'https://api.xstocks.fi/api/v2/public/assets';
const PAGE_SIZE = 100;
// Defensive ceiling, not a top-N market selection. Full validated pagination
// is retained up to 2,500 issuer assets before the response is marked partial.
const MAX_PAGES = 25;
const MAX_PAGE_BYTES = 2_000_000;
const PageSchema = z.object({
  nodes: z.array(z.unknown()).max(PAGE_SIZE),
  page: z.object({ currentPage: z.number().int().nonnegative(), hasNextPage: z.boolean() }).passthrough(),
}).passthrough();
type Page = z.infer<typeof PageSchema>;

function retryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

async function boundedText(response: Response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new MarketProviderError('INVALID_RESPONSE');
  if (!response.body) {
    const body = await response.text();
    if (body.length > MAX_PAGE_BYTES) throw new MarketProviderError('INVALID_RESPONSE');
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PAGE_BYTES) throw new MarketProviderError('INVALID_RESPONSE');
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    // A size-limit failure must not keep downloading the rest of an oversized page.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

function delay(milliseconds: number) { return new Promise<void>(resolve => setTimeout(resolve, milliseconds)); }

export function createXstocksIssuerReader(options: {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const cache = new MarketProviderCache({ provider: 'xstocks', monitoringProvider: 'XSTOCKS',
    operation: 'asset_registry', ttlMs: 60 * 60_000, staleMs: 24 * 60 * 60_000, now: options.now });
  const pages = new Map<number, { page: Page; etag: string | null }>();
  const requestPage = async (pageNumber: number): Promise<Page> => {
    const old = pages.get(pageNumber);
    const url = `${BASE_URL}?network=Solana&listingCountry=US&page=${pageNumber}&pageSize=${PAGE_SIZE}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(12_000);
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/json', ...(old?.etag ? { 'if-none-match': old.etag } : {}) },
          signal: timeout, cache: 'no-store',
        });
        if (response.status === 304) {
          if (!old) throw new MarketProviderError('INVALID_RESPONSE', 304);
          return old.page;
        }
        if (response.status === 429) throw new MarketProviderError('RATE_LIMIT', 429, retryAfter(response.headers.get('retry-after')));
        if (response.status >= 500) throw new MarketProviderError('HTTP_SERVER', response.status);
        if (!response.ok) throw new MarketProviderError('HTTP_CLIENT', response.status);
        let data: unknown;
        try { data = JSON.parse(await boundedText(response)); }
        catch (error) {
          if (error instanceof MarketProviderError) throw error;
          throw new MarketProviderError('INVALID_JSON', response.status);
        }
        const parsed = PageSchema.safeParse(data);
        if (!parsed.success) throw new MarketProviderError('INVALID_RESPONSE', response.status);
        if (parsed.data.page.currentPage !== pageNumber) throw new MarketProviderError('PAGE_MISMATCH', response.status);
        pages.set(pageNumber, { page: parsed.data, etag: response.headers.get('etag') });
        return parsed.data;
      } catch (error) {
        const failure = error instanceof MarketProviderError ? error
          : new MarketProviderError(timeout.aborted ? 'TIMEOUT' : 'NETWORK');
        const transient = ['RATE_LIMIT', 'HTTP_SERVER', 'TIMEOUT', 'NETWORK'].includes(failure.issue);
        if (!transient || attempt === 1 || (failure.retryAfter ?? 0) > 2) throw failure;
        const backoff = Math.max((failure.retryAfter ?? 0) * 1000, 250 * 2 ** attempt + Math.floor(Math.random() * 100));
        await sleep(backoff);
      }
    }
    throw new MarketProviderError('NETWORK');
  };

  const load = async (): Promise<ProviderLoad> => {
    const records: ProviderCandidate[] = [];
    const seen = new Set<string>();
    const issues: ProviderIssue[] = [];
    const retrievedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      let page: Page;
      try { page = await requestPage(pageNumber); }
      catch (error) {
        const failure = error instanceof MarketProviderError ? error : new MarketProviderError('NETWORK');
        if (records.length === 0) throw failure;
        return { records, complete: false, issues: [...issues, failure.issue, 'PARTIAL_PAGE'], retryAfter: failure.retryAfter };
      }
      let badRecord = false;
      const valid = page.nodes.flatMap(input => {
        const parsed = XstockAssetSchema.safeParse(input);
        if (!parsed.success) { badRecord = true; return []; }
        const asset = parsed.data;
        // The live issuer currently omits underlying.type on many otherwise
        // exact Solana deployments. Keep the issuer proof and US listing, but
        // preserve an unknown class instead of silently dropping every mint.
        // Class-dependent calculations remain separately gated downstream.
        if (asset.underlying?.listingCountry !== 'US') return [];
        return [asset];
      });
      if (badRecord) issues.push('INVALID_RECORD');
      for (const record of normalizeStockUniverse(valid, [], retrievedAt)) {
        if (seen.has(record.mint)) continue;
        seen.add(record.mint);
        const parsed = ProviderCandidateSchema.safeParse({ variant: adaptLegacyXstockRecord(record).variant, supply: null });
        if (parsed.success) records.push(parsed.data);
        else issues.push('INVALID_RECORD');
      }
      if (!page.page.hasNextPage) return { records, complete: !issues.includes('INVALID_RECORD'), issues };
    }
    return { records, complete: false, issues: [...issues, 'PAGE_LIMIT'] };
  };

  return { read: () => cache.read(load), reset: () => { cache.reset(); pages.clear(); } };
}

const shared = createXstocksIssuerReader();
export const readXstocksIssuerCandidates = shared.read;
