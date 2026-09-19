import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { mergeJupiterStockMetadata, mergeSolanaMintMetadata, mergeVisiblePrices, normalizeStockUniverse, selectTopIssuerRecords, snapshotXstockAssets, type JupiterLendVault } from '@/adapters/market/stocks';
import { estimatePremiumDiscount, localStockContext, type PremiumDiscountInput } from '@/domain/stock-intelligence';
import { StockMarketDetailSchema, StockMarketQuerySchema, selectStockMarketPage, summarizeStockMarket, type StockMarketRecord } from '@/domain/stocks';
import { boundedIntelligenceRecords, lendForRecord, normalizeIssuerMultiplier, SharedKeyedResourceCache, VISIBLE_INTELLIGENCE_LIMIT } from '@/services/stocks-market';
import { sampleProvider } from '@/services/sample';

const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const otherMint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const now = Date.parse('2026-09-16T12:00:00.000Z');
const nowIso = new Date(now).toISOString();

function record(): StockMarketRecord {
  const asset = { name: 'Acme xStock', symbol: 'ACMEx', underlyingSymbol: 'ACME', underlyingIsin: 'US0000000001',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity' as const, listingCountry: 'US' },
    isTradingHalted: false, trading: { currency: 'USD', currentPeriod: 'market' as const, openNow: true, isTradingHalted: false },
    deployments: [{ address: mint, network: 'Solana' }] };
  const token = { id: mint, name: 'Acme token', symbol: 'ACMEx', decimals: 8,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', usdPrice: 110, liquidity: 1000, mcap: 2000,
    stats24h: { priceChange: 1, buyVolume: 10, sellVolume: 20 }, updatedAt: nowIso };
  return mergeVisiblePrices(normalizeStockUniverse([asset], [token], nowIso), new Map([[mint, {
    usdPrice: 110, blockId: 1, decimals: 8, priceChange24h: 1, retrievedAt: nowIso,
  }]]))[0];
}

function input(overrides: Partial<PremiumDiscountInput> = {}): PremiumDiscountInput {
  const base = record();
  return {
    record: base, issuerMint: mint, issuerPriceUsd: '100', issuerCurrency: 'USD', issuerPriceRetrievedAt: nowIso,
    jupiterPriceVerified: true,
    multiplier: { status: 'current', current: '2', pending: null, activationAt: null, reason: null },
    tradingHalted: false, sameDisplayShareUnit: true, now, ...overrides,
  };
}

describe('Phase 3 differentiated stock intelligence', () => {
  it('classifies only independently verified exact-ISIN ETFs when issuer type is null', () => {
    const assets = snapshotXstockAssets().assets;
    const spy = assets.find(asset => asset.symbol === 'SPYx')!;
    const nvda = assets.find(asset => asset.symbol === 'NVDAx')!;
    expect(spy.underlying?.type).toBeNull();
    expect(nvda.underlying?.type).toBeNull();
    const records = normalizeStockUniverse([spy, nvda], [], nowIso);
    expect(records.find(item => item.issuerSymbol === 'SPYx')?.assetType).toBe('etf');
    expect(records.find(item => item.issuerSymbol === 'NVDAx')?.assetType).toBe('equity');
    const spoofed = normalizeStockUniverse([{ ...spy, underlyingIsin: 'US0000000000', underlying: { ...spy.underlying!, isin: 'US0000000000' } }], [], nowIso);
    expect(spoofed[0].assetType).toBe('unknown');
    const wrongMint = normalizeStockUniverse([{ ...nvda, deployments: [{ address: otherMint, network: 'Solana' }] }], [], nowIso);
    expect(wrongMint[0].assetType).toBe('unknown');
  });

  it('separates live Price V3, display-only references, and missing prices in filters', () => {
    const live = record();
    const reference = { ...live, mint: otherMint, priceUsd: '100', priceSource: 'jupiter-tokens-v2-reference' as const };
    const missing = { ...live, mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', priceUsd: null, priceSource: 'none' as const };
    const records = [live, reference, missing];
    const filter = (price: string) => selectStockMarketPage(records, StockMarketQuerySchema.parse({ price })).records.map(item => item.mint);
    expect(filter('available')).toEqual([mint, otherMint]);
    expect(filter('v3')).toEqual([mint]);
    expect(filter('reference')).toEqual([otherMint]);
    expect(filter('unavailable')).toEqual([missing.mint]);
    expect(StockMarketQuerySchema.safeParse({ price: 'company-cap' }).success).toBe(false);
  });

  it('keeps the reported tokenized-cap sum partial and never substitutes company capitalization', () => {
    const base = record();
    const other = { ...base, mint: otherMint, tokenizedMarketCapUsd: null };
    const summary = summarizeStockMarket([base, other]);
    expect(summary.tokenizedMarketCapUsd).toBe('2000');
    expect(summary.tokenizedMarketCapCoverage).toBe(1);
    expect(summary.discovered).toBe(2);
    expect('companyMarketCapUsd' in summary).toBe(false);
  });

  it.each([
    ['110', '10'], ['90', '-10'], ['100', '0'],
  ])('calculates a safely labelled premium/discount for %s versus 100', (jupiter, expected) => {
    const base = record();
    const result = estimatePremiumDiscount(input({ record: { ...base, priceUsd: jupiter } }));
    expect(result).toMatchObject({ status: 'available', valuePct: expected, reason: null, label: 'estimated' });
  });

  it.each<[string, Partial<PremiumDiscountInput>, string]>([
    ['missing Jupiter price', { record: { ...record(), priceUsd: null } }, 'no-jupiter-price'],
    ['unverified Price V3 source', { jupiterPriceVerified: false }, 'no-jupiter-price'],
    ['missing issuer quote', { issuerPriceUsd: null }, 'no-issuer-price'],
    ['stale Jupiter price', { now: now + 120_001 }, 'stale-jupiter-price'],
    ['display unit mismatch', { sameDisplayShareUnit: false }, 'unit-mismatch'],
    ['unresolved multiplier', { multiplier: { status: 'unavailable', current: null, pending: null, activationAt: null, reason: null } }, 'unit-mismatch'],
    ['currency mismatch', { issuerCurrency: 'EUR' }, 'currency-mismatch'],
    ['pending corporate action', { multiplier: { status: 'pending', current: '1', pending: '2', activationAt: '2026-09-17T00:30:00.000Z', reason: 'split' } }, 'pending-multiplier'],
    ['trading halt', { tradingHalted: true }, 'trading-halted'],
    ['unverified issuer', { issuerMint: otherMint }, 'issuer-unverified'],
  ])('fails closed for %s', (_label, overrides, reason) => {
    expect(estimatePremiumDiscount(input(overrides))).toMatchObject({ status: 'unavailable', valuePct: null, reason });
  });

  it('uses the multiplier exactly once as a unit gate, never as another price multiplier', () => {
    expect(estimatePremiumDiscount(input({ multiplier: { status: 'current', current: '2', pending: null, activationAt: null, reason: null } })).valuePct).toBe('10');
  });

  it('normalizes pending dividend/split state and suppresses comparison until resolved', () => {
    const multiplier = normalizeIssuerMultiplier({ currentMultiplier: 1, newMultiplier: 1.25, activationDateTime: (now + 60_000) / 1000, reason: 'DVCA', retrievedAt: nowIso }, now);
    expect(multiplier).toMatchObject({ status: 'pending', current: '1', pending: '1.25', reason: 'DVCA' });
    expect(estimatePremiumDiscount(input({ multiplier })).reason).toBe('pending-multiplier');
  });

  it('matches Jupiter Lend only by exact collateral mint and never by symbol', () => {
    const base = record();
    const vault = { id: 80, supplyToken: { address: mint, symbol: 'ACMEx' }, borrowToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }, collateralFactor: '750', liquidationThreshold: '800' } as JupiterLendVault;
    expect(lendForRecord(base, [vault], nowIso)).toMatchObject({ status: 'available', vaults: [{ vaultId: 80, maxBorrowLtv: '0.75', liquidationThreshold: '0.8' }] });
    expect(lendForRecord({ ...base, mint: otherMint, tokenSymbol: 'ACMEx' }, [vault], nowIso)).toMatchObject({ status: 'not-found', vaults: [] });
    expect(lendForRecord(base, null, null)).toMatchObject({ status: 'unavailable', vaults: [] });
  });

  it('bounds visible issuer reads to eight records', () => {
    const records = Array.from({ length: 50 }, (_, index) => ({ ...record(), mint: `X${String(index).padStart(31, '1')}` }));
    expect(VISIBLE_INTELLIGENCE_LIMIT).toBe(8);
    expect(boundedIntelligenceRecords(records)).toHaveLength(8);
  });

  it('deduplicates concurrent identical keyed calls and caps cache-key cardinality', async () => {
    const cache = new SharedKeyedResourceCache<string>(1000, 1000, 2); let calls = 0;
    const loader = async () => { calls++; await Promise.resolve(); return 'value'; };
    const [first, second] = await Promise.all([cache.read('NVDAx', loader), cache.read('NVDAx', loader)]);
    expect(calls).toBe(1); expect([first.state, second.state].sort()).toEqual(['miss', 'shared-inflight']);
    await cache.read('TSLAx', loader); await cache.read('SPYx', loader);
    expect(cache.size).toBe(2);
  });

  it('bounds repeat calls after an issuer failure and retries after the cooldown', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(nowIso));
      const cache = new SharedKeyedResourceCache<string>(1000, 1000, 2, 60_000);
      const loader = vi.fn().mockRejectedValueOnce(Error('provider unavailable')).mockResolvedValue('recovered');
      await expect(cache.read('SPYx', loader)).rejects.toThrow('provider unavailable');
      await expect(cache.read('SPYx', loader)).rejects.toThrow('cooling down');
      expect(loader).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      await expect(cache.read('SPYx', loader)).resolves.toMatchObject({ value: 'recovered' });
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps core market identity and dated Jupiter fields when optional providers fail', () => {
    const base = record();
    const failed = { ...base, intelligence: { ...base.intelligence!, issuerIndicativePriceUsd: null, issuerPriceRetrievedAt: null, lend: lendForRecord(base, null, null) } };
    expect(failed).toMatchObject({ mint, issuerVerified: true, priceUsd: '110', intelligence: { lend: { status: 'unavailable' } } });
  });

  it('can recover exact-mint token metadata after a transient cold-load failure', () => {
    const withoutMetadata = normalizeStockUniverse([{
      name: 'Acme xStock', symbol: 'ACMEx', underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
      deployments: [{ address: mint, network: 'Solana' }],
    }], [], nowIso);
    expect(withoutMetadata[0]).toMatchObject({ mint, tokenProgram: null, decimals: null });
    const recovered = mergeJupiterStockMetadata(withoutMetadata, [{
      id: mint, name: 'Acme token', symbol: 'ACMEx', decimals: 8,
      tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidity: 25, stats24h: null,
    }], nowIso);
    expect(recovered[0]).toMatchObject({
      mint, decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', liquidityUsd: '25',
    });
    expect(recovered[0].warnings).not.toContain('Jupiter token metadata is unavailable for this exact issuer deployment mint.');
  });

  it('uses exact Solana mint-account metadata as a bounded unit-validation fallback', () => {
    const withoutMetadata = normalizeStockUniverse([{
      name: 'Acme xStock', symbol: 'ACMEx', underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
      deployments: [{ address: mint, network: 'Solana' }],
    }], [], nowIso);
    const recovered = mergeSolanaMintMetadata(withoutMetadata, [{
      mint, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 8, retrievedAt: nowIso,
    }]);
    expect(recovered[0]).toMatchObject({ mint, decimals: 8, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' });
    expect(recovered[0].sources.at(-1)?.label).toBe('Solana RPC mint account');
  });

  it('labels supply as issuer-reported across every xStocks chain deployment', () => {
    const base = record();
    const parsed = StockMarketDetailSchema.parse({ status: 'ready', issues: [], record: { ...base, intelligence: { ...base.intelligence!, supply: { circulating: '10', total: '12', scope: 'all-xstocks-chain-deployments', retrievedAt: nowIso } } } });
    expect(parsed.record.intelligence?.supply?.scope).toBe('all-xstocks-chain-deployments');
  });

  it('derives wallet-held and protected badges locally from the portfolio snapshot', async () => {
    const result = await sampleProvider.read(null);
    if (result.status === 'error') throw Error(result.message);
    const context = localStockContext(result.data);
    expect(context.held.has(mint)).toBe(true);
    expect(context.protectedMints.has(mint)).toBe(true);
  });

  it('keeps sorting and paging responsive for a 300-record universe', () => {
    const records = Array.from({ length: 300 }, (_, index) => ({ ...record(), mint: `X${String(index).padStart(31, '1')}`, liquidityUsd: String(index) }));
    const started = performance.now();
    const page = selectStockMarketPage(records, { search: '', assetType: 'all', issuer: 'confirmed', price: 'all', sort: 'liquidity', direction: 'desc', page: 15, pageSize: 20 });
    expect(page.records).toHaveLength(20); expect(page.total).toBe(300); expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps the reviewed major-stock mints in a capped issuer universe when ranking data is absent', () => {
    const major = { ...record(), tokenName: 'ZZZ NVIDIA xStock', priceUsd: null, liquidityUsd: null, volume24hUsd: null, tokenizedMarketCapUsd: null };
    const alphabetical = Array.from({ length: 300 }, (_, index) => ({
      ...major, mint: `X${String(index).padStart(31, '1')}`, tokenName: `A stock ${String(index).padStart(3, '0')}`,
    }));
    const selected = selectTopIssuerRecords([...alphabetical, major], 300);
    expect(selected).toHaveLength(300);
    expect(selected.some(row => row.mint === mint)).toBe(true);
  });
});
