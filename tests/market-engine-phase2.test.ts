import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { mergeVisiblePricesV2, normalizeStockUniverse, type JupiterMarketPrice } from '@/adapters/market/stocks';
import { MeteoraPoolSchema, USDC_MINT, readMeteoraPoolIndexes, selectMeteoraPool, type IndexedMeteoraPool } from '@/adapters/meteora/market';
import { compareMarketSources, marketFreshness, projectJupiterObservation, type MarketSourceComparison, type MarketUpdateFailure } from '@/domain/market-observations';
import type { StockMarketRecord } from '@/domain/stocks';
import { isMarketResolverV2Enabled, isMeteoraMarketEnabled, mergePriceBatchIntoLkg, resetStockMarketCacheForTests, SharedResourceCache, trackComparisonTransition } from '@/services/stocks-market';
import { monitoringStore } from '@/services/monitoring/log-manager';

const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const otherMint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const now = Date.parse('2026-09-17T03:00:00.000Z');
const nowIso = new Date(now).toISOString();

function record(): StockMarketRecord {
  return normalizeStockUniverse([{
    name: 'NVIDIA xStock', symbol: 'NVDAx', underlying: { symbol: 'NVDA', isin: 'US67066G1040', type: 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }],
  }], [{
    id: mint, name: 'NVIDIA xStock', symbol: 'NVDAx', decimals: 8, tokenProgram,
    usdPrice: null, liquidity: 10_000, mcap: 100_000, stats24h: null, updatedAt: nowIso,
  }], nowIso)[0];
}

function price(retrievedAt = nowIso, value = 100): JupiterMarketPrice {
  return { usdPrice: value, blockId: 42, decimals: 8, priceChange24h: 1.5, retrievedAt };
}

function rawPool(overrides: Record<string, unknown> = {}) {
  return MeteoraPoolSchema.parse({
    address: 'F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a', name: 'NVDAx-USDC',
    token_x: { address: mint, name: 'NVIDIA xStock', symbol: 'NVDAx', decimals: 8, is_verified: true },
    token_y: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC', decimals: 6, is_verified: true },
    current_price: 102, tvl: 12_000, volume: { '24h': 5000 }, fees: { '24h': 12 }, is_blacklisted: false,
    ...overrides,
  });
}

function indexed(pool = rawPool(), protocol: IndexedMeteoraPool['protocol'] = 'dlmm'): IndexedMeteoraPool[] {
  return [{ protocol, pool }];
}

function observation(ageMs = 0) {
  return projectJupiterObservation({ mint, priceUsd: '100', priceChange24hPct: '1', blockId: 1, decimals: 8, retrievedAt: new Date(now - ageMs).toISOString() }, now);
}

function comparable(overrides: Partial<Parameters<typeof compareMarketSources>[0]> = {}) {
  const pool = selectMeteoraPool(record(), indexed(), nowIso)!;
  return compareMarketSources({
    enabled: true, jupiter: observation(), meteora: pool, exactMint: true, sameCurrency: true,
    sameDisplayUnit: true, multiplierResolved: true, quoteConversionVerified: true,
    orientationResolved: true, minimumLiquidityUsd: '1000', now, ...overrides,
  });
}

describe('Phase 2 reliable prices and bounded Meteora intelligence', () => {
  beforeEach(() => {
    process.env.MARKET_LIVE_MS = '45000'; process.env.MARKET_DELAYED_MS = '120000'; process.env.MARKET_STALE_MS = '600000';
    process.env.MARKET_DIVERGENCE_THRESHOLD_PCT = '5'; process.env.METEORA_MIN_LIQUIDITY_USD = '1000';
    monitoringStore().clear(); resetStockMarketCacheForTests();
  });

  it('preserves an omitted validated Jupiter value and its original timestamp', () => {
    const cache = new Map([[mint, price()]]); const failures = new Map<string, MarketUpdateFailure>();
    mergePriceBatchIntoLkg(cache, failures, [mint], new Map(), true, now + 30_000);
    expect(cache.get(mint)).toEqual(price());
    expect(failures.get(mint)).toMatchObject({ kind: 'omitted', at: new Date(now + 30_000).toISOString() });
    const projected = mergeVisiblePricesV2([record()], cache, failures, now + 30_000)[0];
    expect(projected).toMatchObject({ priceUsd: '100', priceUpdatedAt: nowIso, marketObservation: { freshness: 'LIVE', updateFailure: { kind: 'omitted' } } });
  });

  it('ages one LKG through live, delayed, stale, and unavailable without substituting zero', () => {
    expect(marketFreshness(nowIso, now + 45_000)).toBe('LIVE');
    expect(marketFreshness(nowIso, now + 45_001)).toBe('DELAYED');
    expect(marketFreshness(nowIso, now + 120_001)).toBe('STALE');
    expect(marketFreshness(nowIso, now + 600_001)).toBe('UNAVAILABLE');
    const unavailable = mergeVisiblePricesV2([record()], new Map([[mint, price()]]), new Map(), now + 600_001)[0];
    expect(unavailable.priceUsd).toBeNull();
    expect(unavailable.marketObservation).toMatchObject({ lastKnownPriceUsd: '100', eligibleForSensitiveUse: false });
    expect(JSON.stringify(unavailable)).not.toContain('"priceUsd":"0"');
  });

  it('recovers once with a new validated update and clears the omission reason', () => {
    const cache = new Map([[mint, price()]]); const failures = new Map<string, MarketUpdateFailure>();
    mergePriceBatchIntoLkg(cache, failures, [mint], new Map(), true, now + 30_000);
    const recoveredAt = new Date(now + 60_000).toISOString();
    mergePriceBatchIntoLkg(cache, failures, [mint], new Map([[mint, price(recoveredAt, 101)]]), true, now + 60_000);
    expect(cache.get(mint)).toMatchObject({ usdPrice: 101, retrievedAt: recoveredAt });
    expect(failures.has(mint)).toBe(false);
  });

  it('keeps the rollback path compatible with the original omission deletion behavior', () => {
    const cache = new Map([[mint, price()]]); const failures = new Map<string, MarketUpdateFailure>();
    mergePriceBatchIntoLkg(cache, failures, [mint], new Map(), false, now);
    expect(cache.has(mint)).toBe(false);
  });

  it('provides independent resolver and Meteora rollback flags', () => {
    process.env.MARKET_RESOLVER_V2 = 'false'; process.env.METEORA_MARKET_ENABLED = 'false';
    expect(isMarketResolverV2Enabled()).toBe(false); expect(isMeteoraMarketEnabled()).toBe(false);
    process.env.MARKET_RESOLVER_V2 = 'true'; process.env.METEORA_MARKET_ENABLED = 'true';
    expect(isMarketResolverV2Enabled()).toBe(true); expect(isMeteoraMarketEnabled()).toBe(true);
  });

  it('selects only an exact, verified, non-blacklisted, sufficiently liquid stock/USDC pool', () => {
    const selected = selectMeteoraPool(record(), indexed(), nowIso)!;
    expect(selected).toMatchObject({ source: 'meteora-dlmm', stockMint: mint, quoteMint: USDC_MINT, orientation: 'stock-x', priceUsd: '102', tvlUsd: '12000', providerObservedAt: null });
    expect(selectMeteoraPool(record(), indexed(rawPool({ tvl: 999 })), nowIso)).toBeNull();
    expect(selectMeteoraPool(record(), indexed(rawPool({ is_blacklisted: true })), nowIso)).toBeNull();
    expect(selectMeteoraPool(record(), indexed(rawPool({ token_x: { address: otherMint, name: 'NVIDIA xStock', symbol: 'NVDAx', decimals: 8, is_verified: true } })), nowIso)).toBeNull();
  });

  it('resolves reversed pool orientation with Decimal arithmetic', () => {
    const reversed = rawPool({
      token_x: { address: USDC_MINT, name: 'USD Coin', symbol: 'USDC', decimals: 6, is_verified: true },
      token_y: { address: mint, name: 'NVIDIA xStock', symbol: 'NVDAx', decimals: 8, is_verified: true },
      current_price: 0.01,
    });
    expect(selectMeteoraPool(record(), indexed(reversed, 'damm-v2'), nowIso)).toMatchObject({ source: 'meteora-damm-v2', orientation: 'stock-y', pairPrice: '0.01', priceUsd: '100' });
  });

  it('rejects provider schema drift and missing required pool semantics', () => {
    expect(MeteoraPoolSchema.safeParse({ ...rawPool(), current_price: '102' }).success).toBe(false);
    expect(MeteoraPoolSchema.safeParse({ ...rawPool(), token_x: { symbol: 'NVDAx' } }).success).toBe(false);
  });

  it('keeps partial Meteora provider failure isolated and deduplicates a shared central index load', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('damm-v2')) throw Error('provider unavailable');
      return new Response(JSON.stringify({ total: 1, pages: 1, current_page: 1, page_size: 1000, data: [rawPool()] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const cache = new SharedResourceCache<Awaited<ReturnType<typeof readMeteoraPoolIndexes>>>(600_000, 600_000);
      const loader = () => readMeteoraPoolIndexes([mint], '1000');
      const [first, second] = await Promise.all([cache.read(loader), cache.read(loader)]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect([first.state, second.state].sort()).toEqual(['miss', 'shared-inflight']);
      expect(first.value).toMatchObject({ protocolsReady: ['dlmm'], issues: ['Meteora DAMM-V2 pool index is temporarily unavailable.'] });
      expect(first.value.pools).toHaveLength(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('uses the exact symmetric difference formula and never averages source values', () => {
    const result = comparable();
    expect(result).toMatchObject({ status: 'AGREE', differencePct: '1.98019802', jupiterPriceUsd: '100', meteoraPriceUsd: '102' });
  });

  it.each<[string, Partial<Parameters<typeof compareMarketSources>[0]>, string]>([
    ['currency', { sameCurrency: false }, 'currency-mismatch'],
    ['unit', { sameDisplayUnit: false }, 'unit-mismatch'],
    ['multiplier', { multiplierResolved: false }, 'multiplier-unresolved'],
    ['quote', { quoteConversionVerified: false }, 'quote-conversion-unverified'],
    ['orientation', { orientationResolved: false }, 'orientation-unresolved'],
    ['liquidity', { minimumLiquidityUsd: '20000' }, 'low-liquidity'],
    ['stale Jupiter', { jupiter: observation(120_001) }, 'jupiter-not-live'],
  ])('returns NOT_COMPARABLE for a %s blocker', (_label, overrides, reason) => {
    expect(comparable(overrides)).toMatchObject({ status: 'NOT_COMPARABLE', reason, differencePct: null });
  });

  it('emits one divergence transition and one recovery transition after consecutive observations', () => {
    const diverged = { ...comparable(), status: 'DIVERGED', differencePct: '10' } as MarketSourceComparison;
    const agreed = { ...comparable(), status: 'AGREE', differencePct: '1' } as MarketSourceComparison;
    trackComparisonTransition(mint, diverged); trackComparisonTransition(mint, diverged); trackComparisonTransition(mint, diverged);
    trackComparisonTransition(mint, agreed); trackComparisonTransition(mint, agreed); trackComparisonTransition(mint, agreed);
    expect(monitoringStore().read().map(event => event.status)).toEqual(['RECOVERED', 'PRICE_DIVERGENCE']);
  });
});
