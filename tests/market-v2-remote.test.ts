import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { CanonicalMarketQuerySchema, projectCanonicalMarket } from '@/domain/market-api-v2';
import { readMarketSnapshot } from '@/services/market-snapshot-reader';
import { MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';
import { bundledMarketV2Catalog } from '@/services/market-v2-engine';
import { marketV2WriterOrigin, readRemoteCanonicalPage, readRemoteLegacyPage,
  readRemoteCanonicalDetail, logCanonicalReaderFailure } from '@/services/market-v2-remote';
import * as freshness from '@/domain/market-client-freshness';
import { readCanonicalMarketPage } from '@/services/market-v2-reader';
import { StockMarketQuerySchema } from '@/domain/stocks';
import { getStockMarketCacheStats, readOfflineStockMarketDetail,
  readOfflineStockMarketPage } from '@/services/stocks-market';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function fallbackPage() {
  const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
    bundledCatalog: bundledMarketV2Catalog(), nowMs: Date.now() });
  return projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({}), nowMs: Date.now() });
}

describe('single-writer canonical remote reader', () => {
  it('accepts only a fixed HTTPS origin, and rejects paths, credentials, and non-TLS production origins', () => {
    expect(marketV2WriterOrigin('https://writer.example.org')).toBe('https://writer.example.org');
    expect(() => marketV2WriterOrigin('https://user:pass@writer.example.org')).toThrow();
    expect(() => marketV2WriterOrigin('https://writer.example.org/other')).toThrow();
    expect(() => marketV2WriterOrigin('http://writer.example.org')).toThrow();
  });

  it('deduplicates concurrent readers and forwards only bounded validated filters', async () => {
    const page = await fallbackPage();
    const fetcher = vi.fn(async (...args: [URL, RequestInit]) => { void args; return Response.json(page); });
    const query = CanonicalMarketQuerySchema.parse({ search: 'NVIDIA', pageSize: 20 });
    const origin = 'https://writer.example.org';
    const result = await Promise.all(Array.from({ length: 20 }, () =>
      readRemoteCanonicalPage(origin, query, fetcher as typeof fetch)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.every(item => item.summary.exactMintCount === page.summary.exactMintCount)).toBe(true);
    const [url, options] = fetcher.mock.calls[0];
    expect(url.searchParams.get('search')).toBe('NVIDIA');
    expect(url.pathname).toBe('/api/markets/v2/stocks');
    expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
  });

  it('rejects non-schema and oversized responses instead of trusting a writer blindly', async () => {
    const origin = 'https://writer.example.org';
    const query = CanonicalMarketQuerySchema.parse({ search: 'bad-schema' });
    await expect(readRemoteCanonicalPage(origin, query,
      vi.fn(async () => Response.json({ version: 2, status: 'ready' })) as typeof fetch)).rejects.toThrow();
    const another = CanonicalMarketQuerySchema.parse({ search: 'oversized' });
    await expect(readRemoteCanonicalPage(origin, another,
      vi.fn(async () => new Response('x', { headers: { 'content-type': 'application/json',
        'content-length': '2000000' } })) as typeof fetch)).rejects.toThrow(/too large/);
  });

  it('keeps reviewed identities visible when the remote writer fails, without substituting prices', async () => {
    vi.stubEnv('MARKET_V2_WRITER_ORIGIN', 'https://writer.example.org');
    const fetcher = vi.fn(async () => { throw new Error('writer offline'); });
    vi.stubGlobal('fetch', fetcher);
    const page = await readCanonicalMarketPage(CanonicalMarketQuerySchema.parse({}));
    expect(page.source).toBe('bundled');
    expect(page.summary.exactMintCount).toBe(921);
    expect(page.summary.priceReturnedMintCount).toBe(0);
    expect(page.records.every(row => row.price === null)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy reviewed identities visible offline without starting its market worker', () => {
    const before = getStockMarketCacheStats();
    const page = readOfflineStockMarketPage(StockMarketQuerySchema.parse({ pageSize: 2 }));
    const detail = readOfflineStockMarketDetail(page.records[0].mint);
    const after = getStockMarketCacheStats();
    expect(page.status).toBe('stale');
    expect(page.summary.discovered).toBe(300);
    expect(page.summary.priceV3Available).toBe(0);
    expect(page.records).toHaveLength(2);
    expect(detail?.status).toBe('stale');
    expect(after.priceLoads).toBe(before.priceLoads);
    expect(after.priceCycles).toBe(before.priceCycles);
  });
});

describe('sanitized canonical remote diagnostics', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL', '1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  const secret = 'PRIVATE_SENTINEL_api_key=https://user:password@private.example/path?token=secret';
  let sequence = 0;
  const query = () => CanonicalMarketQuerySchema.parse({ search: `diagnostic-${++sequence}` });
  function expectDiagnostic(stage: string, errorType: string, reason: string) {
    expect(console.error).toHaveBeenLastCalledWith({ event: 'canonical_reader_failure', stage, errorType, reason });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  }

  it('preserves successful payloads, caching and concurrent request counts without logging', async () => {
    const page = await fallbackPage();
    const readQuery = query();
    const fetcher = vi.fn(async () => Response.json(page));
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher)));
    for (const result of results) expect(result).toEqual(page);
    expect(await readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher)).toEqual(page);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    [new TypeError(secret), 'TypeError', 'fetch_failed'],
    [new DOMException(secret, 'TimeoutError'), 'TimeoutError', 'request_timeout'],
    [new DOMException(secret, 'AbortError'), 'AbortError', 'request_aborted'],
    [Object.assign(new Error(secret), { name: secret, cause: { token: secret } }), 'UnknownError', 'fetch_failed'],
    [secret, 'UnknownError', 'unclassified_failure'],
  ])('preserves transport exceptions and excludes their contents (%#)', async (error, type, reason) => {
    const fetcher = vi.fn(async () => { throw error; });
    await expect(readRemoteCanonicalPage('https://writer.example.org', query(), fetcher)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expectDiagnostic('remote_fetch', String(type), String(reason));
  });

  it.each([
    [() => new Response(secret, { status: 503 }), 'Error', 'response_unavailable'],
    [() => new Response(secret, { headers: { 'content-type': 'text/html' } }), 'Error', 'response_unavailable'],
    [() => new Response(null, { headers: { 'content-type': 'application/json' } }), 'Error', 'response_empty'],
    [() => new Response(secret, { headers: { 'content-type': 'application/json', 'content-length': '1500001' } }), 'Error', 'response_too_large'],
    [() => new Response(' '.repeat(1_500_001), { headers: { 'content-type': 'application/json' } }), 'Error', 'response_too_large'],
    [() => new Response(secret, { headers: { 'content-type': 'application/json' } }), 'SyntaxError', 'invalid_json'],
    [() => Response.json({ status: secret, confidential: secret }), 'ZodError', 'schema_validation_failed'],
  ])('classifies rejected responses without logging bodies or schema issues (%#)', async (response, type, reason) => {
    const fetcher = vi.fn(async () => response());
    await expect(readRemoteCanonicalPage('https://writer.example.org', query(), fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expectDiagnostic('response_validation', type, reason);
  });

  it('keeps the existing last-good fallback and logs only its failed upstream read', async () => {
    const page = await fallbackPage();
    const readQuery = query();
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json(page));
    await readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher);
    vi.setSystemTime(Date.now() + 6_000);
    fetcher.mockRejectedValueOnce(new Error(secret));
    const expected = freshness.ageCanonicalPage(page, Date.now(), true);
    expect(await readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
    expectDiagnostic('remote_fetch', 'Error', 'fetch_failed');
  });

  it('logs cached fallback failures and preserves the original fallback exception', async () => {
    const page = await fallbackPage();
    const readQuery = query();
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json(page));
    await readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher);
    vi.setSystemTime(Date.now() + 6_000);
    fetcher.mockRejectedValueOnce(new Error(secret));
    const error = new Error(secret);
    vi.spyOn(freshness, 'ageCanonicalPage').mockImplementationOnce(() => { throw error; });
    await expect(readRemoteCanonicalPage('https://writer.example.org', readQuery, fetcher)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(2);
    expectDiagnostic('fallback', 'Error', 'unclassified_failure');
  });

  it('does not add diagnostics to legacy or detail readers, or outside Vercel', async () => {
    const error = new Error(secret);
    const fetcher = vi.fn(async () => { throw error; });
    await expect(readRemoteLegacyPage('https://writer.example.org', StockMarketQuerySchema.parse({}), fetcher)).rejects.toBe(error);
    await expect(readRemoteCanonicalDetail('https://writer.example.org', 'diagnostic-detail', fetcher)).rejects.toBe(error);
    vi.stubEnv('VERCEL', '0');
    await expect(readRemoteCanonicalPage('https://writer.example.org', query(), fetcher)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('cannot leak a changing error name or be disrupted by error getters', () => {
    const changing = new Error(secret);
    let calls = 0;
    Object.defineProperty(changing, 'name', { get: () => ++calls === 1 ? 'Error' : secret });
    logCanonicalReaderFailure('fallback', changing);
    expectDiagnostic('fallback', 'Error', 'unclassified_failure');
    const hostile = new Error(secret);
    Object.defineProperty(hostile, 'name', { get: () => { throw new Error(secret); } });
    expect(() => logCanonicalReaderFailure('fallback', hostile)).not.toThrow();
    expectDiagnostic('fallback', 'UnknownError', 'unclassified_failure');
  });

  it('preserves the original failure even if the logging sink throws', async () => {
    vi.mocked(console.error).mockImplementation(() => { throw new Error('sink failed'); });
    const error = new Error(secret);
    const fetcher = vi.fn(async () => { throw error; });
    await expect(readRemoteCanonicalPage('https://writer.example.org', query(), fetcher)).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
