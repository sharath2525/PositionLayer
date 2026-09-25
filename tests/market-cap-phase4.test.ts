import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import {
  calculateCoveredSolanaCap, calculateVariantSolanaCap, type SolanaSupplyObservation,
} from '@/domain/market-cap-policy';
import { OptionalCompanyCapSchema } from '@/domain/market-types';
import { type VariantTokenObservation } from '@/domain/market-price-policy';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { issuerSnapshotUniverse } from '@/services/stocks-market';

const at = '2026-09-25T00:00:00.000Z';
const now = Date.parse(at);
const a = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const b = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

function candidate(mint: string) {
  const record = normalizeStockUniverse([{
    name: 'Acme xStock', symbol: 'ACMEx',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }],
  }], [], at)[0];
  const variant = adaptLegacyXstockRecord(record).variant;
  return { variant: { ...variant,
    economicUnit: { kind: 'display-share' as const, unitId: 'acme-common' },
    multiplier: { status: 'current' as const, current: '1', pending: null, activationAt: null },
    reportedTokenizedCapUsd: '999999999',
  }, supply: null };
}
function registry() {
  return buildUniverseRegistry({ reviewed: [], now: at, reads: [{ provider: 'xstocks', status: 'ready',
    records: [candidate(a), candidate(b)], lastSuccess: at, lastAttempt: at,
    retryAfter: null, issues: [] }, { provider: 'jupiter-stocks-tag', status: 'ready',
    records: [], lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
}
function price(mint: string, amount: string): VariantTokenObservation {
  return { mint, provider: 'jupiter-price-v3', price: amount, currency: 'USD',
    unit: { kind: 'display-share', id: 'acme-common' }, multiplierVersion: '1',
    providerObservedAt: null, retrievedAt: at };
}
function supply(mint: string, amount: string): SolanaSupplyObservation {
  return { mint, scope: 'solana-circulating', circulatingBasis: 'verified-solana-circulating',
    amount, unit: { kind: 'display-share', id: 'acme-common' }, multiplierVersion: '1',
    observedAt: at, retrievedAt: at, sourceUrl: 'https://issuer.example/supply' };
}
function one(options: { prices?: VariantTokenObservation[]; supplies?: SolanaSupplyObservation[];
  now?: number } = {}) {
  const row = registry().entries.find(item => item.variant.mint === a)!;
  return calculateVariantSolanaCap({ entry: row, canonicalVariantCount: 2,
    observations: options.prices ?? [price(a, '10')],
    supplies: options.supplies ?? [supply(a, '3')], now: options.now ?? now });
}

describe('Phase 4 separate Solana tokenized-cap policy', () => {
  it('sums each exact Solana mint once, not canonical rows, issuer all-chain supply, or Jupiter reported mcap', () => {
    const input = { registry: registry(), observations: [price(a, '10'), price(b, '20')],
      supplies: [supply(a, '3'), supply(a, '3'), supply(b, '4')], now };
    expect(input.registry.assets).toHaveLength(1);
    const result = calculateCoveredSolanaCap(input);
    expect(result.summary).toMatchObject({ status: 'complete', valueUsd: '110',
      eligibleMintCount: 2, unavailableMintCount: 0, verifiedMintCount: 2,
      coveragePct: '100', catalogStatus: 'available', oldestInputAt: at });
    expect(result.variants.map(item => item.mint).sort()).toEqual([a, b].sort());
    expect(result.variants[0]).toMatchObject({ status: 'eligible', supplyScope: 'solana-circulating',
      supplySourceUrl: 'https://issuer.example/supply', priceProvider: 'jupiter-price-v3' });
    expect(result.summary.valueUsd).not.toBe('999999999');
  });

  it('reports exact partial mint coverage and excludes missing data without zero substitution', () => {
    const result = calculateCoveredSolanaCap({ registry: registry(), observations: [price(a, '10')],
      supplies: [supply(a, '3')], now });
    expect(result.summary).toMatchObject({ status: 'partial', valueUsd: '30',
      eligibleMintCount: 1, unavailableMintCount: 1, verifiedMintCount: 2, coveragePct: '50',
      excluded: [{ mint: b, reason: 'missing-supply' }] });
    const empty = calculateCoveredSolanaCap({ registry: registry(), observations: [], supplies: [], now });
    expect(empty.summary).toMatchObject({ status: 'unavailable', valueUsd: null,
      eligibleMintCount: 0, unavailableMintCount: 2, coveragePct: '0' });
    const degraded = calculateCoveredSolanaCap({ registry: { ...registry(), status: 'degraded' },
      observations: [price(a, '10'), price(b, '20')],
      supplies: [supply(a, '3'), supply(b, '4')], now });
    expect(degraded.summary).toMatchObject({ status: 'partial', valueUsd: '110',
      catalogStatus: 'stale', eligibleMintCount: 2, unavailableMintCount: 0 });
  });

  it.each([
    ['missing supply', [], [price(a, '10')], 'missing-supply'],
    ['all-chain supply', [{ ...supply(a, '3'), scope: 'issuer-all-chain' }], [price(a, '10')], 'wrong-supply-scope'],
    ['mint total', [{ ...supply(a, '3'), scope: 'solana-total-minted' }], [price(a, '10')], 'wrong-supply-scope'],
    ['unknown circulation', [{ ...supply(a, '3'), circulatingBasis: 'unknown' }], [price(a, '10')], 'unknown-circulating-basis'],
    ['wrong share unit', [{ ...supply(a, '3'), unit: { kind: 'display-share', id: 'other-share' } }], [price(a, '10')], 'unit-mismatch'],
    ['wrong multiplier', [{ ...supply(a, '3'), multiplierVersion: '2' }], [price(a, '10')], 'unit-mismatch'],
    ['missing price', [supply(a, '3')], [], 'missing-price'],
    ['invalid price', [supply(a, '3')], [price(a, '0')], 'invalid-price'],
    ['wrong currency', [supply(a, '3')], [{ ...price(a, '10'), currency: 'EUR' }], 'currency-mismatch'],
  ] as const)('blocks %s with %s', (_label, supplies, prices, reason) => {
    expect(one({ supplies: [...supplies] as SolanaSupplyObservation[],
      prices: [...prices] as VariantTokenObservation[] }))
      .toMatchObject({ status: 'unavailable', reason, valueUsd: null });
  });

  it('blocks stale/future supply, stale price, contradictory supply and pending multiplier', () => {
    expect(one({ supplies: [supply(a, '3')], now: now + 24 * 60 * 60 * 1000 + 1 }))
      .toMatchObject({ status: 'unavailable', reason: 'stale-supply' });
    expect(one({ supplies: [{ ...supply(a, '3'), observedAt: new Date(now + 10_000).toISOString() }] }))
      .toMatchObject({ status: 'unavailable', reason: 'future-dated' });
    expect(one({ prices: [price(a, '10')], now: now + 46_000 }))
      .toMatchObject({ status: 'unavailable', reason: 'stale-price' });
    expect(one({ supplies: [supply(a, '3'), supply(a, '4')] }))
      .toMatchObject({ status: 'unavailable', reason: 'conflicting-supply' });
    const row = registry().entries.find(item => item.variant.mint === a)!;
    expect(calculateVariantSolanaCap({ entry: { ...row, variant: { ...row.variant,
      multiplier: { status: 'pending', current: '1', pending: '2', activationAt: at } } },
      canonicalVariantCount: 2, observations: [price(a, '10')], supplies: [supply(a, '3')], now }))
      .toMatchObject({ status: 'unavailable', reason: 'pending-multiplier' });
  });

  it('keeps company capitalization separate and unavailable when class-aware inputs are absent', () => {
    const equity = OptionalCompanyCapSchema.parse({ status: 'unavailable', valueUsd: null,
      reason: 'share-class-unresolved' });
    const etf = OptionalCompanyCapSchema.parse({ status: 'not-applicable', valueUsd: null, reason: 'etf' });
    expect(equity.valueUsd).toBeNull();
    expect(etf.status).toBe('not-applicable');
    expect(one()).toMatchObject({ status: 'eligible', valueUsd: '30' });
  });

  it('does not turn the reviewed 300-mint fallback or reported Jupiter caps into a derived total', () => {
    const reviewed = issuerSnapshotUniverse().records.map(record => ({
      variant: adaptLegacyXstockRecord(record).variant, supply: null,
    }));
    const catalog = buildUniverseRegistry({ reviewed, reads: [], now: at });
    const result = calculateCoveredSolanaCap({ registry: catalog, observations: [], supplies: [], now });
    expect(result.summary).toMatchObject({ status: 'unavailable', valueUsd: null,
      verifiedMintCount: 300, unavailableMintCount: 300, eligibleMintCount: 0,
      catalogStatus: 'stale' });
    expect(result.variants.every(item => item.status === 'unavailable')).toBe(true);
  });
});
