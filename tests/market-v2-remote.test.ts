import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { CanonicalMarketQuerySchema, projectCanonicalMarket } from '@/domain/market-api-v2';
import { readMarketSnapshot } from '@/services/market-snapshot-reader';
import { MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';
import { bundledMarketV2Catalog } from '@/services/market-v2-engine';
import { marketV2WriterOrigin, readRemoteCanonicalPage } from '@/services/market-v2-remote';
import { readCanonicalMarketPage } from '@/services/market-v2-reader';
import { StockMarketQuerySchema } from '@/domain/stocks';
import { getStockMarketCacheStats, readOfflineStockMarketDetail,
  readOfflineStockMarketPage } from '@/services/stocks-market';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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
