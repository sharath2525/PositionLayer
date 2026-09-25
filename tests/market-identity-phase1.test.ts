import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { issuerSnapshotUniverse } from '@/services/stocks-market';
import { summarizeStockMarket } from '@/domain/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import {
  CanonicalStockAssetSchema, CoveredSolanaCapSchema, MarketIdentityConflictSchema,
  OptionalCompanyCapSchema, SolanaStockVariantSchema, SourceEvidenceSchema, VariantCapSchema,
} from '@/domain/market-types';

const at = '2026-09-24T12:00:00.000Z';
const mintA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const mintB = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const mintC = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';

function asset(mint: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'Acme xStock', symbol: 'ACMEx', underlyingSymbol: 'ACME', underlyingIsin: 'US0000000001',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity' as const, listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }], ...overrides,
  };
}

function candidate(mint: string, overrides: Record<string, unknown> = {}) {
  return adaptLegacyXstockRecord(normalizeStockUniverse([asset(mint, overrides)], [], at)[0]);
}

describe('Phase 1 additive stock identity contracts', () => {
  it('keeps two exact issuer mints separate while exposing only a candidate grouping key', () => {
    const left = candidate(mintA);
    const right = candidate(mintB);
    expect(left.canonical.id).not.toBe(right.canonical.id);
    expect(left.canonical.candidateGroupingKey).toBe('isin:US0000000001:equity');
    expect(right.canonical.candidateGroupingKey).toBe(left.canonical.candidateGroupingKey);
    expect(left.variant.evidence[0]).toMatchObject({ kind: 'issuer-declaration', exactMint: mintA });
    expect(right.variant.evidence[0]).toMatchObject({ kind: 'issuer-declaration', exactMint: mintB });
    expect(left.variant.economicUnit.kind).toBe('unknown');
    expect(left.variantCap).toMatchObject({ status: 'unavailable', reason: 'missing-supply', valueUsd: null });
  });

  it('does not group identical tickers with different underlying securities', () => {
    const left = candidate(mintA);
    const right = candidate(mintB, {
      underlyingIsin: 'US0000000002',
      underlying: { symbol: 'ACME', isin: 'US0000000002', type: 'Equity', listingCountry: 'US' },
    });
    expect(right.variant.tokenSymbol).toBe(left.variant.tokenSymbol);
    expect(right.canonical.candidateGroupingKey).not.toBe(left.canonical.candidateGroupingKey);
  });

  it('keeps ETF and equity product classes distinct even with a matching ISIN', () => {
    const equity = candidate(mintA);
    const etf = candidate(mintC, {
      underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'ETF', listingCountry: 'US' },
    });
    expect(equity.canonical.candidateGroupingKey).not.toBe(etf.canonical.candidateGroupingKey);
    expect(etf.companyCap).toEqual({ status: 'not-applicable', valueUsd: null, reason: 'etf' });
    expect(equity.companyCap).toEqual({ status: 'unavailable', valueUsd: null, reason: 'missing-cik' });
  });

  it('requires an exact issuer declaration before allowing issuer-confirmed status', () => {
    const base = candidate(mintA).variant;
    expect(SolanaStockVariantSchema.safeParse({ ...base, evidence: [{ ...base.evidence[0], exactMint: mintB }] }).success).toBe(false);
    expect(SourceEvidenceSchema.safeParse({ ...base.evidence[0], provider: 'jupiter' }).success).toBe(false);
    expect(SolanaStockVariantSchema.safeParse({ ...base, multiplier: { status: 'pending', current: '1', pending: null, activationAt: at } }).success).toBe(false);
    expect(MarketIdentityConflictSchema.parse({ reason: 'multiplier-mismatch', affectedMints: [mintA, mintB], explanation: 'Different display-share units.', detectedAt: at }).reason).toBe('multiplier-mismatch');
    expect(VariantCapSchema.parse({ status: 'unavailable', mint: mintA, reason: 'pending-multiplier', supplyScope: 'solana-circulating', valueUsd: null }).valueUsd).toBeNull();
  });

  it('keeps unknown, unverified, and non-US classifications unresolved', () => {
    const unknown = candidate(mintA, { underlying: { symbol: 'ACME', isin: 'US0000000001', listingCountry: 'US' } });
    expect(unknown.variant.productClass).toBe('unknown');
    expect(unknown.variant.eligibility).toBe('unresolved');
    expect(unknown.canonical.candidateGroupingKey).toBeNull();
    const nonUs = candidate(mintB, { underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'GB' } });
    expect(nonUs.variant.eligibility).toBe('unresolved');
    expect(SolanaStockVariantSchema.safeParse({ ...unknown.variant, eligibility: 'eligible' }).success).toBe(false);
  });

  it('does not promote a same-ticker Jupiter index record into issuer proof', () => {
    const indexed = normalizeStockUniverse([], [{
      id: mintB, name: 'Acme token lookalike', symbol: 'ACMEx', decimals: 8,
      tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      usdPrice: 10, liquidity: 100, mcap: 1000, stats24h: null,
    }], at)[0];
    const adapted = adaptLegacyXstockRecord(indexed);
    expect(adapted.variant.verification).toBe('indexed-only');
    expect(adapted.variant.eligibility).toBe('unresolved');
    expect(adapted.variant.evidence[0].kind).toBe('discovery-index');
    expect(adapted.canonical.candidateGroupingKey).toBeNull();
  });

  it('cannot call all-chain or total-minted supply a Solana circulating cap', () => {
    const valid = {
      status: 'eligible', mint: mintA, supplyScope: 'solana-circulating', supply: '100',
      supplyUnit: 'display-share:v1', supplyObservedAt: at, tokenPriceUsd: '10',
      priceUnit: 'display-share:v1', priceObservedAt: at, multiplier: '1', valueUsd: '1000',
    };
    expect(VariantCapSchema.safeParse(valid).success).toBe(true);
    expect(VariantCapSchema.safeParse({ ...valid, supplyScope: 'issuer-all-chain' }).success).toBe(false);
    expect(VariantCapSchema.safeParse({ ...valid, supplyScope: 'solana-total-minted' }).success).toBe(false);
    expect(VariantCapSchema.safeParse({ ...valid, priceUnit: 'raw-token' }).success).toBe(false);
    expect(VariantCapSchema.parse({ status: 'unavailable', mint: mintA, reason: 'wrong-supply-scope', supplyScope: 'issuer-all-chain', valueUsd: null }).status).toBe('unavailable');
  });

  it('requires honest coverage and cannot substitute zero for a wholly unavailable cap', () => {
    const partial = {
      status: 'partial', valueUsd: '1000', eligibleMintCount: 1, unavailableMintCount: 1,
      verifiedMintCount: 2, coveragePct: '50', catalogStatus: 'stale', oldestInputAt: at,
      excluded: [{ mint: mintB, reason: 'missing-supply' }],
    };
    expect(CoveredSolanaCapSchema.safeParse(partial).success).toBe(true);
    expect(CoveredSolanaCapSchema.safeParse({ ...partial, status: 'complete' }).success).toBe(false);
    expect(CoveredSolanaCapSchema.safeParse({ ...partial, coveragePct: '100' }).success).toBe(false);
    expect(CoveredSolanaCapSchema.safeParse({ ...partial, eligibleMintCount: 0, unavailableMintCount: 2, valueUsd: '0' }).success).toBe(false);
    expect(CoveredSolanaCapSchema.safeParse({ ...partial, excluded: [] }).success).toBe(false);
  });

  it('keeps company cap independently gated and validates canonical uniqueness', () => {
    expect(OptionalCompanyCapSchema.safeParse({ status: 'estimated', valueUsd: '1000', cik: '1' }).success).toBe(false);
    const canonical = candidate(mintA).canonical;
    expect(CanonicalStockAssetSchema.safeParse({ ...canonical, variantMints: [mintA, mintA] }).success).toBe(false);
    expect(CanonicalStockAssetSchema.safeParse({ ...canonical, verification: 'conflicted' }).success).toBe(false);
  });

  it('adapts all 300 current fallback records without changing their counts or prices', () => {
    const providerFetch = vi.spyOn(globalThis, 'fetch');
    const snapshot = issuerSnapshotUniverse();
    const before = summarizeStockMarket(snapshot.records);
    const candidates = snapshot.records.map(adaptLegacyXstockRecord);
    expect(candidates).toHaveLength(300);
    expect(new Set(candidates.map(item => item.variant.mint)).size).toBe(300);
    expect(candidates.every(item => item.variant.verification === 'issuer-confirmed')).toBe(true);
    expect(candidates.every(item => item.variantCap.status === 'unavailable')).toBe(true);
    expect(candidates.every(item => item.canonical.variantMints.length === 1)).toBe(true);
    expect(summarizeStockMarket(snapshot.records)).toEqual(before);
    expect(providerFetch).not.toHaveBeenCalled();
    providerFetch.mockRestore();
  });
});
