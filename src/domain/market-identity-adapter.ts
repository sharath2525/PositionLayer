import type { StockMarketRecord } from './stocks';
import {
  CanonicalStockAssetSchema, OptionalCompanyCapSchema, SolanaStockVariantSchema,
  VariantCapSchema, type CanonicalStockAsset, type OptionalCompanyCap,
  type SolanaStockVariant, type VariantCap,
} from './market-types';

export type LegacyIdentityCandidate = {
  canonical: CanonicalStockAsset;
  variant: SolanaStockVariant;
  variantCap: VariantCap;
  companyCap: OptionalCompanyCap;
};

/**
 * Additive Phase 1 bridge. It does not group mints, choose a price, derive a
 * capitalization, or participate in the current Stocks route.
 */
export function adaptLegacyXstockRecord(record: StockMarketRecord): LegacyIdentityCandidate {
  const issuerSource = record.sources.find(source => source.label === 'xStocks public asset registry');
  const exactIssuer = record.identityClass === 'issuer-confirmed-xstock' && record.issuerVerified && !!issuerSource;
  const productClass = record.assetType;
  const verifiedIsin = record.underlyingIsin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(record.underlyingIsin)
    ? record.underlyingIsin : null;
  const listingCountry = record.listingCountry && /^[A-Z]{2}$/.test(record.listingCountry)
    ? record.listingCountry : null;
  const eligible = exactIssuer && verifiedIsin !== null && listingCountry === 'US'
    && (productClass === 'equity' || productClass === 'etf');
  const evidence = exactIssuer ? [{
    kind: 'issuer-declaration' as const, provider: 'xstocks' as const, exactMint: record.mint,
    underlyingIsin: verifiedIsin, productClass,
    sourceUrl: issuerSource.url, observedAt: issuerSource.observedAt, retrievedAt: issuerSource.retrievedAt,
  }] : [{
    kind: 'discovery-index' as const, provider: 'jupiter' as const, exactMint: record.mint,
    underlyingIsin: null, productClass: null,
    sourceUrl: record.sources[0].url, observedAt: record.sources[0].observedAt,
    retrievedAt: record.sources[0].retrievedAt,
  }];
  const multiplier = record.intelligence?.multiplier;
  const variant = SolanaStockVariantSchema.parse({
    chain: 'solana', mint: record.mint, issuer: exactIssuer ? 'xstocks' : 'unknown',
    tokenName: record.tokenName, tokenSymbol: record.tokenSymbol, tokenProgram: record.tokenProgram,
    decimals: record.decimals, productClass,
    underlying: {
      isin: verifiedIsin, symbol: record.underlyingSymbol,
      securityClass: null, listingCountry,
    },
    // Existing records do not prove a common economic/share unit across issuers.
    economicUnit: { kind: 'unknown', unitId: null },
    multiplier: {
      status: multiplier?.status ?? 'unavailable', current: multiplier?.current ?? null,
      pending: multiplier?.pending ?? null, activationAt: multiplier?.activationAt ?? null,
    },
    tradingHalted: record.intelligence?.market.tradingHalted ?? null,
    verification: exactIssuer ? 'issuer-confirmed' : 'indexed-only',
    eligibility: eligible ? 'eligible' : 'unresolved',
    availability: {
      catalog: 'unknown', price: record.priceSource === 'jupiter-price-v3' && record.priceUsd !== null
        ? (record.marketObservation?.freshness === 'LIVE' ? 'available' : 'stale') : 'unknown',
      liquidity: record.liquidityUsd === null ? 'unavailable' : 'available',
      lend: record.intelligence?.lend.status === 'available' ? 'available' : 'unknown',
      issuerStatus: record.intelligence?.market.tradingHalted === null || !record.intelligence
        ? 'unknown' : 'available',
    },
    evidence, retrievedAt: record.retrievedAt,
    reportedTokenizedCapUsd: record.tokenizedMarketCapUsd,
    reportedLiquidityUsd: record.liquidityUsd,
    reportedVolume24hUsd: record.volume24hUsd,
    reportedMarketRetrievedAt: record.tokenizedMarketCapUsd !== null || record.liquidityUsd !== null
      ? record.sources.find(source => source.label.includes('Jupiter Tokens V2'))?.retrievedAt ?? null : null,
  });
  // Keep one canonical placeholder per exact mint. Phase 3, not this adapter,
  // will decide whether matching candidate keys can be safely grouped.
  const canonical = CanonicalStockAssetSchema.parse({
    id: `solana:${record.mint}`,
    candidateGroupingKey: eligible ? `isin:${verifiedIsin}:${productClass}` : null,
    productClass, underlyingIsin: verifiedIsin, securityClass: null,
    verification: variant.verification, variantMints: [record.mint], conflicts: [],
    retrievedAt: record.retrievedAt,
  });
  const variantCap = VariantCapSchema.parse({
    status: 'unavailable', mint: record.mint,
    reason: 'missing-supply', supplyScope: 'unknown', valueUsd: null,
  });
  const companyCap = OptionalCompanyCapSchema.parse(productClass === 'etf'
    ? { status: 'not-applicable', valueUsd: null, reason: 'etf' }
    : { status: 'unavailable', valueUsd: null, reason: 'missing-cik' });
  return { canonical, variant, variantCap, companyCap };
}
