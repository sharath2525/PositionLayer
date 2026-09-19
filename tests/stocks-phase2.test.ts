import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { activeSolanaXstockAssets, featuredXstockAssets, mergeVisiblePrices, mergeVisiblePricesV2, normalizeStockUniverse, readXstocksSolanaAssets, selectTopIssuerRecords, snapshotXstockAssets, solanaDeploymentMints, splitPriceBatches } from '@/adapters/market/stocks';
import { jupiterRequestHeaders, retryAfterSeconds } from '@/adapters/jupiter-api/client';
import { StockMarketPageSchema, StockMarketQuerySchema, selectStockMarketPage, summarizeStockMarket } from '@/domain/stocks';
import { advancePriceBatchCursor, buildPriceCycleBatches, issuerSnapshotUniverse, mayWakePriceWorker, priceWorkerBackoffMs, SharedResourceCache } from '@/services/stocks-market';

const mintA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const mintB = '11111111111111111111111111111111';
const mintC = 'So11111111111111111111111111111111111111112';
const now = '2026-09-16T04:00:00.000Z';

function xstock(mint = mintA) {
  return { name: 'Acme xStock', symbol: 'ACMEx', underlyingSymbol: 'ACME', underlyingIsin: 'US0000000001',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity' as const, listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }] };
}
function token(mint = mintA, overrides: Record<string, unknown> = {}) {
  return { id: mint, name: 'Acme token', symbol: 'ACMEx', decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    isVerified: true, tags: ['stocks'], usdPrice: 12.5, liquidity: 2500, mcap: 5000, holderCount: 77,
    stats24h: { priceChange: 1.29, buyVolume: 100, sellVolume: 50 }, updatedAt: now, ...overrides };
}

describe('Phase 2 public stock market', () => {
  it('keeps a complete dated issuer identity fallback when the live registry is unavailable', () => {
    const snapshot = snapshotXstockAssets();
    const activeMints = solanaDeploymentMints(activeSolanaXstockAssets(snapshot.assets));
    expect(activeMints.length).toBeGreaterThanOrEqual(300);
    expect(new Set(activeMints).size).toBe(activeMints.length);
    const fallback = issuerSnapshotUniverse();
    expect(fallback.records).toHaveLength(300);
    expect(fallback.xstocks).toBe('stale');
    expect(fallback.records.every(record => record.issuerVerified && record.priceUsd === null)).toBe(true);
    expect(fallback.issues.join(' ')).toContain('snapshot');
    expect(buildPriceCycleBatches(fallback.records.map(record => record.mint)).map(batch => batch.length)).toEqual([50, 50, 50, 50, 50, 50]);
  });

  it('labels Tokens V2 quotes as display-only when Price V3 omits a mint', () => {
    const record = normalizeStockUniverse([xstock()], [token()], now)[0];
    const projected = mergeVisiblePricesV2([record], new Map(), new Map(), Date.parse(now))[0];
    expect(projected).toMatchObject({ priceUsd: '12.5', priceSource: 'jupiter-tokens-v2-reference' });
    expect(projected.marketObservation).toMatchObject({ freshness: 'UNAVAILABLE', eligibleForSensitiveUse: false });
    expect(summarizeStockMarket([projected])).toMatchObject({ priceAvailable: 1, priceV3Available: 0, referencePriceAvailable: 1 });
    expect(projected.sources.some(source => source.label === 'Jupiter Price V3')).toBe(false);
    const verified = mergeVisiblePricesV2([record], new Map([[mintA, { usdPrice: 13, blockId: 1, decimals: 8, retrievedAt: now }]]), new Map(), Date.parse(now))[0];
    expect(verified).toMatchObject({ priceUsd: '13', priceSource: 'jupiter-price-v3' });
    expect(summarizeStockMarket([verified])).toMatchObject({ priceV3Available: 1, referencePriceAvailable: 0 });
  });

  it('uses a small reviewed issuer universe with exact unique Solana mints', () => {
    const assets = featuredXstockAssets();
    const records = normalizeStockUniverse(assets, [], now);
    expect(records).toHaveLength(6);
    expect(new Set(records.map(record => record.mint)).size).toBe(6);
    expect(records.every(record => record.issuerVerified && record.identityClass === 'issuer-confirmed-xstock')).toBe(true);
    expect(records.filter(record => record.assetType === 'equity')).toHaveLength(4);
    expect(records.filter(record => record.assetType === 'etf')).toHaveLength(2);
  });

  it('joins issuer identity only by the exact Solana deployment mint', () => {
    const records = normalizeStockUniverse([xstock()], [token(), token(mintB, { name: 'Same ticker impostor', symbol: 'ACMEx' })], now);
    expect(records).toHaveLength(2);
    expect(records.find(record => record.mint === mintA)).toMatchObject({ identityClass: 'issuer-confirmed-xstock', issuerVerified: true, underlyingSymbol: 'ACME' });
    expect(records.find(record => record.mint === mintB)).toMatchObject({ identityClass: 'jupiter-stock-tagged', issuerVerified: false, underlyingSymbol: null });
  });

  it('keeps same-symbol different-mint records separate and deduplicates duplicate mints', () => {
    const records = normalizeStockUniverse([xstock(), xstock()], [token(), token(), token(mintB, { symbol: 'ACMEx' })], now);
    expect(records.map(record => record.mint).sort()).toEqual([mintA, mintB].sort());
    expect(summarizeStockMarket(records).discovered).toBe(2);
    expect(summarizeStockMarket(records).liquidMarkets).toBe(2);
  });

  it('normalizes only Phase 2 fields and preserves Price V3 percent-point semantics', () => {
    const record = normalizeStockUniverse([xstock()], [token()], now)[0];
    expect(record).toMatchObject({ priceUsd: '12.5', priceChange24hPct: '1.29', liquidityUsd: '2500', volume24hUsd: '150', tokenizedMarketCapUsd: '5000' });
    expect(record.logoUrl).toBe('https://xstocks-metadata.backed.fi/logos/tokens/ACMEx.png');
    expect(record).not.toHaveProperty('premiumDiscount');
    expect(record).not.toHaveProperty('proofOfReserves');
    expect(record).not.toHaveProperty('lendAvailability');
  });

  it('never converts an omitted price to zero', () => {
    const record = normalizeStockUniverse([xstock()], [token(mintA, { usdPrice: null })], now)[0];
    expect(record.priceUsd).toBeNull();
    expect(mergeVisiblePrices([record], new Map())[0].priceUsd).toBeNull();
  });

  it('can apply price availability after the bounded featured batch is merged', () => {
    const records = normalizeStockUniverse(featuredXstockAssets(), [], now);
    const priced = mergeVisiblePrices(records, new Map([[mintA, { usdPrice: 10, blockId: 1, decimals: 8, priceChange24h: 2, retrievedAt: now }]]));
    const query = StockMarketQuerySchema.parse({ issuer: 'confirmed', price: 'available', sort: 'price' });
    expect(selectStockMarketPage(priced, query).records.map(record => record.mint)).toEqual([mintA]);
    expect(summarizeStockMarket(priced).priceAvailable).toBe(1);
  });

  it('applies bounded search and filters with stable null-last sorting', () => {
    const base = normalizeStockUniverse([xstock()], [token(), token(mintB, { name: 'Beta', symbol: 'BETA', liquidity: null, usdPrice: null }), token(mintC, { name: 'Gamma ETF', symbol: 'GAMMA', liquidity: 2500 })], now);
    const query = StockMarketQuerySchema.parse({ issuer: 'other', sort: 'liquidity', direction: 'desc', pageSize: '2' });
    const selected = selectStockMarketPage(base, query);
    expect(selected.records.map(record => record.mint)).toEqual([mintC, mintB]);
    expect(selectStockMarketPage(base, { ...query, search: 'US0000000001', issuer: 'all' }).records.map(record => record.mint)).toEqual([mintA]);
    expect(selectStockMarketPage(base, { ...query, issuer: 'all', assetType: 'equity' }).records).toHaveLength(1);
    expect(selectStockMarketPage(base, { ...query, issuer: 'all', price: 'unavailable' }).records.map(record => record.mint)).toEqual([mintB]);
  });

  it('caps page size and Price V3 batches at 50 unique IDs', () => {
    expect(StockMarketQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false);
    expect(StockMarketQuerySchema.safeParse({ page: 5000 }).success).toBe(false);
    expect(StockMarketQuerySchema.safeParse({ search: 'x'.repeat(65) }).success).toBe(false);
    const batches = splitPriceBatches(Array.from({ length: 121 }, (_, index) => `mint-${index}`).concat('mint-0'));
    expect(batches.map(batch => batch.length)).toEqual([50, 50, 21]);
    expect(new Set(batches.flat()).size).toBe(121);
  });

  it('builds six sequential Price V3 batches for a 300-mint cycle', () => {
    const mints = Array.from({ length: 300 }, (_, index) => `mint-${index}`);
    const batches = buildPriceCycleBatches(mints);
    expect(batches).toHaveLength(6);
    expect(batches.every(batch => batch.length === 50)).toBe(true);
    expect(new Set(batches.flat()).size).toBe(300);
    let cursor = 0;
    cursor = advancePriceBatchCursor(cursor, true);
    cursor = advancePriceBatchCursor(cursor, false);
    expect(batches[cursor]).toEqual(mints.slice(50, 100));
    cursor = advancePriceBatchCursor(cursor, true);
    expect(batches[cursor]).toEqual(mints.slice(100, 150));
  });

  it('prioritizes visible mints once without duplicating them in the rolling cycle', () => {
    const mints = Array.from({ length: 300 }, (_, index) => `mint-${index}`);
    const priority = ['mint-80', 'mint-81', 'mint-80'];
    const batches = buildPriceCycleBatches(mints, priority);
    expect(batches[0]).toEqual(['mint-80', 'mint-81']);
    expect(batches.flat().filter(mint => mint === 'mint-80')).toHaveLength(1);
    expect(new Set(batches.flat()).size).toBe(300);
  });

  it('filters halted issuer assets and ranks priced liquid records before unavailable records', () => {
    const active = xstock(mintA);
    const halted = { ...xstock(mintB), isTradingHalted: true };
    expect(activeSolanaXstockAssets([active, halted])).toEqual([active]);
    const records = normalizeStockUniverse([active, xstock(mintB)], [token(mintA, { liquidity: 5 }), token(mintB, { usdPrice: null, liquidity: 10_000 })], now);
    expect(selectTopIssuerRecords(records, 2).map(record => record.mint)).toEqual([mintA, mintB]);
  });

  it('sends only exact Solana deployment mints to Jupiter metadata', () => {
    const asset = { ...xstock(mintA), deployments: [
      { address: '0x19b7680118fd54b8d52ef922afb3bbb13e3ad47f', network: 'Ethereum' },
      { address: mintA, network: 'Solana' },
      { address: 'EQDydJ5fwPRG6t4uPJqAwYIXyL2kMJfvZz7Zh8WYfMcbILoI', network: 'Ton' },
    ] };
    expect(solanaDeploymentMints([asset])).toEqual([mintA]);
  });

  it('honors Retry-After and applies bounded exponential worker backoff', () => {
    expect(priceWorkerBackoffMs(1, 7, 0)).toBe(7000);
    expect(priceWorkerBackoffMs(1, null, 0)).toBe(2000);
    expect(priceWorkerBackoffMs(10, null, 1)).toBe(60500);
    expect(mayWakePriceWorker(0, 40_000, 35_000)).toBe(false);
    expect(mayWakePriceWorker(0, 40_000, 40_000)).toBe(true);
  });

  it('deduplicates concurrent server cache loads and serves stale data after refresh failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    const cache = new SharedResourceCache<string>(1000, 5000);
    let calls = 0;
    const loader = async () => { calls++; await Promise.resolve(); return 'validated'; };
    const [first, second] = await Promise.all([cache.read(loader), cache.read(loader)]);
    expect(calls).toBe(1);
    expect([first.state, second.state].sort()).toEqual(['miss', 'shared-inflight']);
    vi.advanceTimersByTime(1500);
    const failingLoader = async () => { calls++; await Promise.resolve(); throw Error('provider timeout'); };
    const [stale, staleConcurrent] = await Promise.all([cache.read(failingLoader), cache.read(failingLoader)]);
    expect(stale).toMatchObject({ value: 'validated', state: 'stale' });
    expect(staleConcurrent).toMatchObject({ value: 'validated', state: 'stale' });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('parses Retry-After seconds and dates without exposing upstream payloads', () => {
    const epoch = Date.parse(now);
    expect(retryAfterSeconds('4', epoch)).toBe(4);
    expect(retryAfterSeconds(new Date(epoch + 6000).toUTCString(), epoch)).toBe(6);
    const record = normalizeStockUniverse([xstock()], [token()], now)[0];
    const validPage = { status: 'ready', records: [record], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      summary: summarizeStockMarket([record]), providers: { xstocks: 'ready', jupiterTokens: 'ready', jupiterPrice: 'ready' },
      cache: { universe: 'hit', visiblePrices: 'hit', universeExpiresAt: now, priceWorker: {
        status: 'idle', cached: 1, target: 1, batchSize: 50, cycleSeconds: 30,
        lastBatchAt: now, lastCycleCompletedAt: now, nextRunAt: null,
      } }, updatedAt: now, issues: [] };
    expect(StockMarketPageSchema.safeParse(validPage).success).toBe(true);
    expect(StockMarketPageSchema.safeParse({ ...validPage, rawProviderBody: { xApiKey: 'secret' } }).success).toBe(false);
  });

  it('keeps the rolling Price V3 worker keyless even when another server integration has a key', () => {
    expect(jupiterRequestHeaders(true, 'server-secret')).toEqual({ Accept: 'application/json' });
    expect(jupiterRequestHeaders(false, 'server-secret')).toMatchObject({ 'x-api-key': 'server-secret' });
  });

  it('rejects schema drift before records enter the normalized market universe', () => {
    expect(() => normalizeStockUniverse([xstock()], [{ ...token(), decimals: '8' }], now)).toThrow();
    expect(() => normalizeStockUniverse([{ ...xstock(), deployments: 'Solana' }], [token()], now)).toThrow();
  });

  it('propagates request abortion instead of retaining a partial upstream body', async () => {
    const original = globalThis.fetch;
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = vi.fn((_input, init) => Promise.reject((init?.signal as AbortSignal).reason || new DOMException('Aborted', 'AbortError')));
    try { await expect(readXstocksSolanaAssets(controller.signal)).rejects.toBeDefined(); }
    finally { globalThis.fetch = original; }
  });
});
