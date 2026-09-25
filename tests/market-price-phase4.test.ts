import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse, mergeVisiblePricesV2 } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { bridgeLegacyMarketRecord } from '@/domain/market-price-bridge';
import {
  resolveCanonicalTokenPrice, resolveVariantTokenPrice, type VariantTokenObservation,
} from '@/domain/market-price-policy';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { issuerSnapshotUniverse } from '@/services/stocks-market';

const at = '2026-09-25T00:00:00.000Z';
const now = Date.parse(at);
const mintA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const mintB = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

function candidate(mint: string, shareUnit: string | null = null) {
  const record = normalizeStockUniverse([{
    name: 'Acme xStock', symbol: 'ACMEx',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }],
  }], [], at)[0];
  const variant = adaptLegacyXstockRecord(record).variant;
  return { variant: { ...variant,
    economicUnit: shareUnit ? { kind: 'display-share' as const, unitId: shareUnit } : variant.economicUnit,
    multiplier: shareUnit ? { status: 'current' as const, current: '1', pending: null, activationAt: null }
      : variant.multiplier,
  }, supply: null };
}
function registry(shared = false) {
  const records = shared ? [candidate(mintA, 'acme-common'), candidate(mintB, 'acme-common')] : [candidate(mintA)];
  return buildUniverseRegistry({ reviewed: [], now: at, reads: [{ provider: 'xstocks', status: 'ready',
    records, lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] },
  { provider: 'jupiter-stocks-tag', status: 'ready', records: [], lastSuccess: at,
    lastAttempt: at, retryAfter: null, issues: [] }] });
}
function observation(mint = mintA, price = '100', unit: 'token-unit' | 'display-share' = 'token-unit',
  overrides: Partial<VariantTokenObservation> = {}): VariantTokenObservation {
  return { mint, provider: 'jupiter-price-v3', price, currency: 'USD',
    unit: { kind: unit, id: unit === 'token-unit' ? `token:${mint}` : 'acme-common' },
    multiplierVersion: unit === 'display-share' ? '1' : null,
    providerObservedAt: null, retrievedAt: at, ...overrides };
}

describe('Phase 4 shadow token-price policy', () => {
  it('selects only an exact-mint live Jupiter token price and preserves separate display-only references', () => {
    const result = resolveCanonicalTokenPrice({ registry: registry(), assetId: `solana:${mintA}`,
      observations: [observation()], now, referenceQuotes: [{ kind: 'issuer-indicative', price: '150',
        currency: 'USD', unitDescription: 'Underlying share', retrievedAt: at, displayOnly: true }] });
    expect(result.selected?.priceUsd).toBe('100');
    expect(result.selected?.provider).toBe('jupiter-price-v3');
    expect(result.referenceQuotes[0].price).toBe('150');
    expect(resolveCanonicalTokenPrice({ registry: registry(), assetId: `solana:${mintA}`,
      observations: [], now, referenceQuotes: result.referenceQuotes })).toMatchObject({
      status: 'unavailable', reason: 'no-token-observation', selected: null,
    });
    const malformedReference = resolveCanonicalTokenPrice({ registry: registry(), assetId: `solana:${mintA}`,
      observations: [observation()], now, referenceQuotes: [{ kind: 'issuer-indicative', price: '-1',
        currency: 'USD', unitDescription: 'Bad optional quote', retrievedAt: at, displayOnly: true }] });
    expect(malformedReference.selected?.priceUsd).toBe('100');
    expect(malformedReference.referenceQuotes).toHaveLength(0);
  });

  it('uses freshest eligible variant then lexical mint, never an average', () => {
    const group = registry(true);
    const assetId = group.assets[0].id;
    const equalTime = resolveCanonicalTokenPrice({ registry: group, assetId,
      observations: [observation(mintA, '100', 'display-share'), observation(mintB, '120', 'display-share')], now });
    expect(equalTime.selected?.mint).toBe([mintA, mintB].sort((a, b) => a.localeCompare(b))[0]);
    expect(equalTime.comparison).toMatchObject({ status: 'DIVERGED', reason: null });
    expect(equalTime.selected?.priceUsd).toBe(equalTime.selected?.mint === mintA ? '100' : '120');
    const newer = resolveCanonicalTokenPrice({ registry: group, assetId,
      observations: [observation(mintA, '100', 'display-share'),
        observation(mintB, '101', 'display-share', { retrievedAt: new Date(now + 1_000).toISOString() })],
      now: now + 1_000 });
    expect(newer.selected?.mint).toBe(mintB);
    expect(newer.comparison.status).toBe('AGREE');
  });

  it.each([
    ['missing', [], 'no-token-observation'],
    ['zero', [observation(mintA, '0')], 'invalid-price'],
    ['malformed', [observation(mintA, 'abc')], 'invalid-price'],
    ['currency', [observation(mintA, '10', 'token-unit', { currency: 'EUR' })], 'currency-mismatch'],
    ['unit', [observation(mintA, '10', 'token-unit', { unit: { kind: 'token-unit', id: `token:${mintB}` } })], 'unit-mismatch'],
    ['no timestamp', [observation(mintA, '10', 'token-unit', { retrievedAt: null })], 'missing-observation-time'],
    ['future', [observation(mintA, '10', 'token-unit', { retrievedAt: new Date(now + 10_000).toISOString() })], 'future-dated'],
    ['stale', [observation()], 'stale-price'],
  ] as const)('returns a typed blocker for %s', (_label, rows, reason) => {
    const group = registry();
    const result = resolveVariantTokenPrice({ variant: group.entries[0].variant,
      catalogState: 'active', conflicts: 0,
      observations: [...rows] as VariantTokenObservation[], canonicalVariantCount: 1,
      now: reason === 'stale-price' ? now + 46_000 : now });
    expect(result).toMatchObject({ status: 'blocked', reason });
  });

  it('blocks pending multipliers, catalog conflicts and incompatible multi-variant units', () => {
    const group = registry(true);
    const first = group.entries[0].variant;
    const pending = { ...first, multiplier: { status: 'pending' as const,
      current: '1', pending: '2', activationAt: at } };
    expect(resolveVariantTokenPrice({ variant: pending, catalogState: 'active', conflicts: 0,
      observations: [observation(first.mint, '10', 'display-share')], canonicalVariantCount: 2, now }))
      .toMatchObject({ status: 'blocked', reason: 'pending-multiplier' });
    expect(resolveVariantTokenPrice({ variant: first, catalogState: 'quarantined', conflicts: 1,
      observations: [observation(first.mint, '10', 'display-share')], canonicalVariantCount: 2, now }))
      .toMatchObject({ status: 'blocked', reason: 'identity-conflict' });
    expect(resolveVariantTokenPrice({ variant: first, catalogState: 'active', conflicts: 1,
      observations: [observation(first.mint, '10', 'display-share')], canonicalVariantCount: 2, now }))
      .toMatchObject({ status: 'blocked', reason: 'identity-conflict' });
    expect(resolveVariantTokenPrice({ variant: first, catalogState: 'active', conflicts: 0,
      observations: [observation(first.mint, '10', 'token-unit')], canonicalVariantCount: 2, now }))
      .toMatchObject({ status: 'blocked', reason: 'unit-mismatch' });
  });

  it('does not label a currency or multiplier mismatch as a price divergence', () => {
    const group = registry(true);
    const currency = resolveCanonicalTokenPrice({ registry: group, assetId: group.assets[0].id,
      observations: [observation(mintA, '100', 'display-share'),
        observation(mintB, '200', 'display-share', { currency: 'EUR' })], now });
    expect(currency.comparison).toMatchObject({ status: 'NOT_COMPARABLE', reason: 'currency-mismatch',
      differencePct: null });
    const multiplier = resolveCanonicalTokenPrice({ registry: group, assetId: group.assets[0].id,
      observations: [observation(mintA, '100', 'display-share'),
        observation(mintB, '200', 'display-share', { multiplierVersion: '2' })], now });
    expect(multiplier.comparison).toMatchObject({ status: 'NOT_COMPARABLE', reason: 'multiplier-unresolved',
      differencePct: null });
  });

  it('bridges existing 300-stock V3/LKG reads without changing price or timestamp, and exposes the migration gate', () => {
    const legacy = issuerSnapshotUniverse();
    expect(legacy.records).toHaveLength(300);
    const record = legacy.records[0];
    const live = mergeVisiblePricesV2([record], new Map([[record.mint, {
      usdPrice: 123.45, blockId: 10, decimals: record.decimals ?? 8, retrievedAt: at,
    }]]), new Map(), now)[0];
    const bridged = bridgeLegacyMarketRecord(live);
    const variant = adaptLegacyXstockRecord(live).variant;
    const decision = resolveVariantTokenPrice({ variant, catalogState: 'active', conflicts: 0,
      observations: bridged.observation ? [bridged.observation] : [], canonicalVariantCount: 1, now });
    // The reviewed 300 snapshot contains unknown product classification, so
    // the stricter future resolver must not silently replace the live policy.
    expect(decision).toMatchObject({ status: 'blocked', reason: 'variant-ineligible' });
    const omitted = mergeVisiblePricesV2([record], new Map([[record.mint, {
      usdPrice: 123.45, blockId: 10, decimals: record.decimals ?? 8, retrievedAt: at,
    }]]), new Map([[record.mint, { kind: 'omitted', at: new Date(now + 20_000).toISOString(),
      message: 'omitted' }]]), now + 20_000)[0];
    expect(bridgeLegacyMarketRecord(omitted).observation?.retrievedAt).toBe(at);
    expect(record.priceUsd).toBeNull();
    expect(live.priceSource).toBe('jupiter-price-v3');
    expect(live.priceUsd).toBe('123.45');
  });
});
