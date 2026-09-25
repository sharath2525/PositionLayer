import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { readReviewedMarketCandidates } from '@/adapters/market/reviewed-candidates';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { ProviderCandidateSchema, ProviderReadResultSchema, type ProviderCandidate } from '@/domain/market-provider';
import { buildUniverseRegistry, findRegistryMint, selectRegistryInputs, UniverseRegistrySchema } from '@/domain/universe-registry';

const t1 = '2026-09-25T00:00:00.000Z';
const t2 = '2026-09-25T01:00:00.000Z';
const t3 = '2026-09-25T02:00:00.000Z';
const mintA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const mintB = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const mintC = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const isinA = 'US0000000001';
const isinB = 'US0000000002';
const tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function issuer(mint: string, options: { isin?: string; product?: 'Equity' | 'ETF'; unit?: string;
  multiplier?: string; symbol?: string; securityClass?: string } = {}): ProviderCandidate {
  const row = normalizeStockUniverse([{
    name: 'Acme xStock', symbol: options.symbol ?? 'ACMEx',
    underlying: { symbol: 'ACME', isin: options.isin ?? isinA,
      type: options.product ?? 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }],
  }], [], t1)[0];
  const variant = adaptLegacyXstockRecord(row).variant;
  return ProviderCandidateSchema.parse({ variant: {
    ...variant,
    underlying: { ...variant.underlying, securityClass: options.securityClass ?? null },
    economicUnit: options.unit ? { kind: 'display-share', unitId: options.unit } : variant.economicUnit,
    multiplier: options.unit ? { status: 'current', current: options.multiplier ?? '1', pending: null, activationAt: null }
      : variant.multiplier,
  }, supply: null });
}
function indexed(mint: string): ProviderCandidate {
  const row = normalizeStockUniverse([], [{
    id: mint, name: 'Acme tagged', symbol: 'ACMEx', decimals: 8, tokenProgram,
    usdPrice: 900, liquidity: 100, mcap: 9000, stats24h: null,
  }], t1)[0];
  return ProviderCandidateSchema.parse({ variant: adaptLegacyXstockRecord(row).variant, supply: null });
}
function read(provider: 'xstocks' | 'jupiter-stocks-tag', records: ProviderCandidate[],
  status: 'ready' | 'partial' | 'stale' | 'unavailable' = 'ready', at = t1) {
  return ProviderReadResultSchema.parse({ provider, status, records,
    lastSuccess: status === 'ready' || status === 'stale' ? at : null,
    lastAttempt: at, retryAfter: status === 'ready' ? null : 30,
    issues: status === 'ready' ? [] : ['NETWORK'] });
}
function mintFor(index: number) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = index + 1;
  let suffix = '';
  do { suffix = alphabet[value % alphabet.length] + suffix; value = Math.floor(value / alphabet.length); } while (value);
  return '1'.repeat(32 - suffix.length) + suffix;
}

describe('Phase 3 pure UniverseRegistry', () => {
  it('merges only the same exact mint and keeps Jupiter discovery subordinate to issuer proof', () => {
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA)]),
      read('jupiter-stocks-tag', [indexed(mintA)])], reviewed: [], now: t1 });
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].variant.verification).toBe('issuer-confirmed');
    expect(registry.entries[0].variant.underlying.isin).toBe(isinA);
    expect(registry.entries[0].variant.evidence.map(item => item.kind)).toContain('discovery-index');
    expect(registry.entries[0].variant.evidence.map(item => item.kind)).toContain('issuer-declaration');
    // Phase 6 may attach separate exact-mint market metadata, never issuer identity.
    expect(registry.entries[0].variant.reportedTokenizedCapUsd).toBe('9000');
    expect(registry.entries[0].variant.reportedLiquidityUsd).toBe('100');
    expect(registry.quarantine).toHaveLength(0);
  });

  it('does not let conflicting discovery token metadata revoke exact issuer identity', () => {
    const exact = issuer(mintA);
    const tagged = indexed(mintA);
    const mismatched = ProviderCandidateSchema.parse({ ...tagged, variant: {
      ...tagged.variant, tokenProgram: '1'.repeat(32), decimals: 9,
      productClass: 'etf', underlying: { ...tagged.variant.underlying, isin: isinB },
    } });
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [exact]),
      read('jupiter-stocks-tag', [mismatched])], reviewed: [], now: t1 });
    expect(registry.entries[0].variant.verification).toBe('issuer-confirmed');
    expect(registry.entries[0].catalogState).toBe('active');
    expect(registry.quarantine).toHaveLength(0);
  });

  it('never treats a matching ticker or Jupiter-only record as issuer confirmation', () => {
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA)]),
      read('jupiter-stocks-tag', [indexed(mintB)])], reviewed: [], now: t1 });
    expect(registry.assets).toHaveLength(2);
    expect(findRegistryMint(registry, mintB)?.variant.verification).toBe('indexed-only');
    expect(findRegistryMint(registry, mintB)?.variant.eligibility).toBe('unresolved');
  });

  it('rejects issuer-looking evidence smuggled through a discovery source', () => {
    const poisoned = ProviderCandidateSchema.parse({ ...indexed(mintA), variant: {
      ...indexed(mintA).variant,
      evidence: [...indexed(mintA).variant.evidence, issuer(mintB).variant.evidence[0]],
    } });
    const registry = buildUniverseRegistry({ reads: [read('jupiter-stocks-tag', [poisoned])],
      reviewed: [], now: t1 });
    expect(registry.entries).toHaveLength(0);
    expect(registry.quarantine).toHaveLength(1);
    expect(registry.quarantine[0].conflict.reason).toBe('issuer-proof-missing');
  });

  it('groups two issuer variants only with identical ISIN, product, security class, economic unit, and current multiplier', () => {
    const rows = [issuer(mintA, { unit: 'acme-common-share', securityClass: 'common' }),
      issuer(mintB, { unit: 'acme-common-share', securityClass: 'common' })];
    const registry = buildUniverseRegistry({ reads: [read('xstocks', rows)], reviewed: [], now: t1 });
    expect(registry.entries).toHaveLength(2);
    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0].variantMints).toEqual([mintA, mintB].sort());
    expect(registry.assets[0].id).toBe(`isin:${isinA}:equity`);
    expect(registry.assets[0].verification).toBe('issuer-confirmed');
  });

  it('keeps unknown economic units separate and never groups by ISIN alone', () => {
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA), issuer(mintB)])],
      reviewed: [], now: t1 });
    expect(registry.assets).toHaveLength(2);
    expect(registry.assets.every(asset => asset.variantMints.length === 1)).toBe(true);
  });

  it('quarantines mismatched economic units and multipliers with typed review reasons', () => {
    const unitMismatch = buildUniverseRegistry({ reads: [read('xstocks', [
      issuer(mintA, { unit: 'share:1' }), issuer(mintB, { unit: 'share:2' }),
    ])], reviewed: [], now: t1 });
    expect(unitMismatch.assets).toHaveLength(2);
    expect(unitMismatch.entries.every(entry => entry.catalogState === 'quarantined')).toBe(true);
    expect(unitMismatch.assets.every(asset => asset.conflicts[0].reason === 'economic-unit-mismatch')).toBe(true);
    const multiplierMismatch = buildUniverseRegistry({ reads: [read('xstocks', [
      issuer(mintA, { unit: 'share:1', multiplier: '1' }),
      issuer(mintB, { unit: 'share:1', multiplier: '2' }),
    ])], reviewed: [], now: t1 });
    expect(multiplierMismatch.assets[0].conflicts[0].reason).toBe('multiplier-mismatch');
  });

  it('quarantines unresolved corporate-action multipliers before grouping variants', () => {
    const current = issuer(mintA, { unit: 'share:1' });
    const pendingBase = issuer(mintB, { unit: 'share:1' });
    const pending = ProviderCandidateSchema.parse({ ...pendingBase, variant: { ...pendingBase.variant,
      multiplier: { status: 'pending', current: '1', pending: '2', activationAt: t2 },
    } });
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [current, pending])],
      reviewed: [], now: t1 });
    expect(registry.assets).toHaveLength(2);
    expect(registry.assets.every(asset => asset.conflicts[0].reason === 'corporate-action-unresolved')).toBe(true);
  });

  it('does not merge ETF with equity or different ISINs even when ticker and unit match', () => {
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [
      issuer(mintA, { unit: 'share:1' }),
      issuer(mintB, { unit: 'share:1', product: 'ETF' }),
      issuer(mintC, { unit: 'share:1', isin: isinB }),
    ])], reviewed: [], now: t1 });
    expect(registry.assets).toHaveLength(3);
    expect(registry.assets.filter(asset => asset.underlyingIsin === isinA)
      .every(asset => asset.conflicts[0].reason === 'product-class-mismatch')).toBe(true);
    expect(registry.assets.find(asset => asset.underlyingIsin === isinB)?.conflicts).toEqual([]);
  });

  it('quarantines a same-mint issuer identity disagreement without crossing evidence', () => {
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA, { isin: isinB })])],
      reviewed: [issuer(mintA)], now: t1 });
    expect(registry.entries).toHaveLength(1);
    expect(registry.quarantine).toHaveLength(1);
    expect(registry.quarantine[0].conflict.reason).toBe('isin-mismatch');
    expect(registry.assets[0].verification).toBe('conflicted');
    expect(registry.entries[0].variant.underlying.isin).toBe(isinA);
  });

  it('retains a previous complete registry when one source fails or is partial', () => {
    const initial = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA), issuer(mintB)])],
      reviewed: [], now: t1 });
    const failed = buildUniverseRegistry({ reads: [read('xstocks', [], 'unavailable', t2),
      read('jupiter-stocks-tag', [indexed(mintC)])], reviewed: [], previous: initial, now: t2 });
    expect(failed.status).toBe('degraded');
    expect(failed.entries.map(entry => entry.variant.mint).sort()).toEqual([mintA, mintB, mintC].sort());
    expect(failed.entries.filter(entry => entry.catalogState === 'delisted')).toHaveLength(0);
    const partial = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA)], 'partial', t2)],
      reviewed: [], previous: initial, now: t2 });
    expect(partial.entries).toHaveLength(2);
    expect(partial.shrink.missing).toBe(0);
    const restored = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA), issuer(mintB)], 'ready', t3)],
      reviewed: [], previous: failed, now: t3 });
    expect(restored.status).toBe('complete');
    expect(restored.entries).toHaveLength(3); // discovery-only mint remains indexed, not erased by issuer recovery
    expect(restored.entries.filter(entry => entry.catalogState === 'delisted')).toHaveLength(0);
  });

  it('records a genuinely empty issuer success, quarantines a large shrink, and requires a distinct second success before delisting', () => {
    const initial = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA), issuer(mintB)])],
      reviewed: [], now: t1 });
    const first = buildUniverseRegistry({ reads: [read('xstocks', [], 'ready', t2)],
      reviewed: [], previous: initial, now: t2 });
    expect(first.issuerEmpty).toBe(true);
    expect(first.shrink).toMatchObject({ missing: 2, priorIssuerMints: 2, quarantined: true });
    expect(first.entries.every(entry => entry.catalogState === 'pending-removal')).toBe(true);
    const sameResponse = buildUniverseRegistry({ reads: [read('xstocks', [], 'ready', t2)],
      reviewed: [], previous: first, now: t2 });
    expect(sameResponse.entries.every(entry => entry.catalogState === 'pending-removal')).toBe(true);
    const confirmed = buildUniverseRegistry({ reads: [read('xstocks', [], 'ready', t3)],
      reviewed: [], previous: sameResponse, now: t3 });
    expect(confirmed.entries.every(entry => entry.catalogState === 'delisted')).toBe(true);
    expect(confirmed.assets).toHaveLength(0);
    const recovered = buildUniverseRegistry({ reads: [read('xstocks', [issuer(mintA)], 'ready', '2026-09-25T03:00:00.000Z')],
      reviewed: [], previous: confirmed, now: '2026-09-25T03:00:00.000Z' });
    expect(findRegistryMint(recovered, mintA)?.catalogState).toBe('active');
    expect(findRegistryMint(recovered, mintB)?.catalogState).toBe('delisted');
  });

  it('distinguishes a validated empty catalog from an outage and quarantines a 90% shrink', () => {
    const empty = buildUniverseRegistry({ reads: [read('xstocks', [])], reviewed: [], now: t1 });
    expect(empty).toMatchObject({ status: 'complete', issuerEmpty: true, entries: [], assets: [] });
    const rows = Array.from({ length: 10 }, (_, index) => issuer(mintFor(index)));
    const initial = buildUniverseRegistry({ reads: [read('xstocks', rows)], reviewed: [], now: t1 });
    const shrunk = buildUniverseRegistry({ reads: [read('xstocks', rows.slice(0, 1), 'ready', t2)],
      reviewed: [], previous: initial, now: t2 });
    expect(shrunk.shrink).toMatchObject({ priorIssuerMints: 10, missing: 9, quarantined: true });
    expect(shrunk.entries.filter(entry => entry.catalogState === 'pending-removal')).toHaveLength(9);
    expect(shrunk.assets).toHaveLength(10);
  });

  it('keeps reviewed exact-mint fallback without any network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const reviewed = readReviewedMarketCandidates();
    const registry = buildUniverseRegistry({ reads: [read('xstocks', [], 'unavailable')], reviewed, now: t1 });
    expect(reviewed.length).toBeGreaterThanOrEqual(300);
    expect(registry.entries.length).toBe(reviewed.length);
    expect(registry.assets.length).toBe(reviewed.length); // economic units remain unresolved
    expect(registry.status).toBe('degraded');
    expect(registry.reviewedOnlyCount).toBe(reviewed.length);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('does not infer delisting for unclassified reviewed assets missing from a filtered issuer read', () => {
    const reviewed = readReviewedMarketCandidates();
    const unclassified = reviewed.find(row => row.variant.eligibility === 'unresolved');
    expect(unclassified).toBeDefined();
    const initial = buildUniverseRegistry({ reads: [], reviewed: [unclassified!], now: t1 });
    const later = buildUniverseRegistry({ reads: [read('xstocks', [], 'ready', t2)],
      reviewed: [unclassified!], previous: initial, now: t2 });
    expect(later.entries[0].catalogState).toBe('active');
    expect(later.entries[0].missingIssuerRefreshes).toBe(0);
    expect(later.reviewedOnlyCount).toBe(1);
    expect(later.status).toBe('degraded');
  });

  it('selects over-ceiling input deterministically, preserves prior capacity, and reports source/counts', () => {
    const input = [
      { source: 'jupiter-stocks-tag' as const, candidate: indexed(mintC) },
      { source: 'xstocks' as const, candidate: issuer(mintB) },
      { source: 'reviewed-snapshot' as const, candidate: issuer(mintA) },
    ];
    const result = selectRegistryInputs(2, input, 4);
    expect(result.allowed.map(item => item.source)).toEqual(['reviewed-snapshot', 'xstocks']);
    expect(result.truncation).toEqual({ truncated: true, discovered: 5, retained: 4,
      sources: ['jupiter-stocks-tag'] });
    expect(selectRegistryInputs(2, [...input].reverse(), 4)).toEqual(result);
  });

  it('handles a 1,000-mint fixture without price selection, fetches, or an accidental 300 cap', () => {
    const base = issuer(mintA);
    const rows = Array.from({ length: 1000 }, (_, index) => ProviderCandidateSchema.parse({
      variant: { ...base.variant, mint: mintFor(index),
        underlying: { ...base.variant.underlying, isin: `US${String(index).padStart(10, '0')}` },
        evidence: base.variant.evidence.map(item => ({ ...item, exactMint: mintFor(index) })) },
      supply: null,
    }));
    const started = performance.now();
    const registry = buildUniverseRegistry({ reads: [read('xstocks', rows)], reviewed: [], now: t1 });
    expect(registry.entries).toHaveLength(1000);
    expect(registry.assets).toHaveLength(1000);
    expect(registry.truncation.truncated).toBe(false);
    expect(registry.assets.every(asset => asset.variantMints.length === 1)).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(UniverseRegistrySchema.safeParse(registry).success).toBe(true);
  });
});
