import { z } from 'zod';
import { decimal } from './amounts';

// Phase 1 contracts only. None of these schemas is used by the live market route.
export const MarketMintSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const MarketTimestampSchema = z.iso.datetime({ offset: true });
export const MarketNonnegativeDecimalSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
export const MarketPositiveDecimalSchema = MarketNonnegativeDecimalSchema.refine(value => decimal(value).gt(0));
export const MarketIsinSchema = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/);
export const MarketProductClassSchema = z.enum(['equity', 'etf', 'leveraged', 'inverse', 'synthetic', 'basket', 'private', 'unknown']);
export const MarketVerificationSchema = z.enum([
  'issuer-confirmed', 'independently-corroborated', 'indexed-only', 'onchain-only', 'unresolved', 'conflicted',
]);
export const MarketSupplyScopeSchema = z.enum(['solana-circulating', 'solana-total-minted', 'issuer-all-chain', 'unknown']);
export const MarketAvailabilitySchema = z.enum(['available', 'stale', 'unavailable', 'unknown']);

export const SourceEvidenceSchema = z.object({
  kind: z.enum(['issuer-declaration', 'reviewed-snapshot', 'onchain-mint', 'discovery-index']),
  provider: z.enum(['xstocks', 'ondo', 'superstate', 'jupiter', 'solana-rpc', 'tokens-xyz', 'reviewed-snapshot']),
  exactMint: MarketMintSchema.nullable(),
  underlyingIsin: MarketIsinSchema.nullable(),
  productClass: MarketProductClassSchema.nullable(),
  sourceUrl: z.url().startsWith('https://'),
  observedAt: MarketTimestampSchema.nullable(),
  retrievedAt: MarketTimestampSchema,
}).strict().superRefine((evidence, context) => {
  if (evidence.kind === 'issuer-declaration' &&
      (!evidence.exactMint || !['xstocks', 'ondo', 'superstate'].includes(evidence.provider))) {
    context.addIssue({ code: 'custom', message: 'Issuer declaration requires its own exact mint and issuer provider.' });
  }
  if (evidence.kind === 'onchain-mint' && (evidence.provider !== 'solana-rpc' || !evidence.exactMint)) {
    context.addIssue({ code: 'custom', message: 'Onchain mint evidence requires Solana RPC and an exact mint.' });
  }
});

export const VariantAvailabilitySchema = z.object({
  catalog: MarketAvailabilitySchema,
  price: MarketAvailabilitySchema,
  liquidity: MarketAvailabilitySchema,
  lend: MarketAvailabilitySchema,
  issuerStatus: MarketAvailabilitySchema,
}).strict();

export const SolanaStockVariantSchema = z.object({
  chain: z.literal('solana'),
  mint: MarketMintSchema,
  issuer: z.enum(['xstocks', 'ondo', 'superstate', 'unknown']),
  tokenName: z.string().min(1).max(160).optional(),
  tokenSymbol: z.string().min(1).max(64),
  tokenProgram: MarketMintSchema.nullable(),
  decimals: z.number().int().min(0).max(30).nullable(),
  productClass: MarketProductClassSchema,
  underlying: z.object({
    isin: MarketIsinSchema.nullable(),
    symbol: z.string().min(1).max(32).nullable(),
    securityClass: z.string().min(1).max(80).nullable(),
    listingCountry: z.string().regex(/^[A-Z]{2}$/).nullable(),
  }).strict(),
  economicUnit: z.object({
    kind: z.enum(['display-share', 'token-unit', 'unknown']),
    unitId: z.string().min(1).max(100).nullable(),
  }).strict(),
  multiplier: z.object({
    status: z.enum(['current', 'pending', 'unavailable']),
    current: MarketPositiveDecimalSchema.nullable(),
    pending: MarketPositiveDecimalSchema.nullable(),
    activationAt: MarketTimestampSchema.nullable(),
  }).strict(),
  tradingHalted: z.boolean().nullable(),
  verification: MarketVerificationSchema,
  eligibility: z.enum(['eligible', 'unresolved', 'excluded']),
  availability: VariantAvailabilitySchema,
  evidence: z.array(SourceEvidenceSchema).min(1).max(12),
  retrievedAt: MarketTimestampSchema,
  // This is Jupiter's reported per-mint field, not a derived Solana-circulating cap.
  reportedTokenizedCapUsd: MarketNonnegativeDecimalSchema.nullable(),
  // Exact-mint Jupiter Tokens V2 liquidity, never issuer identity evidence.
  reportedLiquidityUsd: MarketNonnegativeDecimalSchema.nullable().optional(),
  // Exact-mint Jupiter Tokens V2 24-hour traded volume; not issuer volume.
  reportedVolume24hUsd: MarketNonnegativeDecimalSchema.nullable().optional(),
  reportedMarketRetrievedAt: MarketTimestampSchema.nullable().optional(),
}).strict().superRefine((variant, context) => {
  const exactIssuerProof = variant.evidence.some(evidence => evidence.kind === 'issuer-declaration'
    && evidence.provider === variant.issuer && evidence.exactMint === variant.mint);
  if (variant.verification === 'issuer-confirmed' && !exactIssuerProof) {
    context.addIssue({ code: 'custom', message: 'Issuer confirmation requires an exact-mint issuer declaration.' });
  }
  if (variant.eligibility === 'eligible' && (variant.verification !== 'issuer-confirmed'
    || !['equity', 'etf'].includes(variant.productClass) || variant.underlying.listingCountry !== 'US'
    || !variant.underlying.isin)) {
    context.addIssue({ code: 'custom', message: 'Ordinary U.S. equity/ETF eligibility needs issuer proof, class, US listing, and ISIN.' });
  }
  if (variant.economicUnit.kind !== 'unknown' && !variant.economicUnit.unitId) {
    context.addIssue({ code: 'custom', message: 'A resolved economic unit needs a unit identifier.' });
  }
  if (variant.multiplier.status === 'current' && !variant.multiplier.current) {
    context.addIssue({ code: 'custom', message: 'Current multiplier needs a positive current value.' });
  }
  if (variant.multiplier.status === 'pending' && (!variant.multiplier.current || !variant.multiplier.pending)) {
    context.addIssue({ code: 'custom', message: 'Pending multiplier needs current and future values.' });
  }
});

export const MarketIdentityConflictSchema = z.object({
  reason: z.enum(['isin-mismatch', 'security-class-mismatch', 'product-class-mismatch', 'economic-unit-mismatch',
    'multiplier-mismatch', 'corporate-action-unresolved', 'duplicate-mint', 'issuer-proof-missing']),
  affectedMints: z.array(MarketMintSchema).min(1).max(20),
  explanation: z.string().min(1).max(240),
  detectedAt: MarketTimestampSchema,
}).strict();

export const CanonicalStockAssetSchema = z.object({
  id: z.string().min(1).max(160),
  // A candidate key is not permission to merge. Phase 3 must review economic class and conflicts.
  candidateGroupingKey: z.string().min(1).max(160).nullable(),
  productClass: MarketProductClassSchema,
  underlyingIsin: MarketIsinSchema.nullable(),
  securityClass: z.string().min(1).max(80).nullable(),
  verification: MarketVerificationSchema,
  variantMints: z.array(MarketMintSchema).min(1).max(2000),
  conflicts: z.array(MarketIdentityConflictSchema).max(20),
  retrievedAt: MarketTimestampSchema,
}).strict().superRefine((asset, context) => {
  if (new Set(asset.variantMints).size !== asset.variantMints.length) {
    context.addIssue({ code: 'custom', message: 'Canonical variants must be unique by exact mint.' });
  }
  if (asset.verification === 'conflicted' && asset.conflicts.length === 0) {
    context.addIssue({ code: 'custom', message: 'Conflicted assets require a typed conflict.' });
  }
});

export const VariantCapSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('eligible'), mint: MarketMintSchema,
    supplyScope: z.literal('solana-circulating'), supply: MarketNonnegativeDecimalSchema,
    supplyUnit: z.string().min(1).max(100), supplyObservedAt: MarketTimestampSchema,
    supplySourceUrl: z.url().startsWith('https://').optional(),
    tokenPriceUsd: MarketPositiveDecimalSchema, priceUnit: z.string().min(1).max(100),
    priceObservedAt: MarketTimestampSchema, priceProvider: z.literal('jupiter-price-v3').optional(),
    multiplier: MarketPositiveDecimalSchema,
    valueUsd: MarketNonnegativeDecimalSchema,
  }).strict().refine(value => value.supplyUnit === value.priceUnit, 'Supply and price economic units must agree'),
  z.object({
    status: z.literal('unavailable'), mint: MarketMintSchema,
    reason: z.enum(['missing-supply', 'wrong-supply-scope', 'stale-supply', 'conflicting-supply',
      'missing-price', 'stale-price', 'invalid-price', 'currency-mismatch', 'unit-mismatch',
      'pending-multiplier', 'multiplier-unresolved', 'unverified-issuer', 'variant-ineligible', 'conflicted-identity',
      'catalog-unconfirmed', 'future-dated', 'unknown-circulating-basis']),
    supplyScope: MarketSupplyScopeSchema,
    valueUsd: z.null(),
  }).strict(),
]);

export const CoveredSolanaCapSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  valueUsd: MarketNonnegativeDecimalSchema.nullable(),
  eligibleMintCount: z.number().int().nonnegative(),
  unavailableMintCount: z.number().int().nonnegative(),
  verifiedMintCount: z.number().int().nonnegative(),
  coveragePct: MarketNonnegativeDecimalSchema,
  catalogStatus: MarketAvailabilitySchema,
  oldestInputAt: MarketTimestampSchema.nullable(),
  excluded: z.array(z.object({ mint: MarketMintSchema, reason: VariantCapSchema.options[1].shape.reason }).strict()).max(20_000),
}).strict().superRefine((cap, context) => {
  if (cap.eligibleMintCount + cap.unavailableMintCount !== cap.verifiedMintCount) {
    context.addIssue({ code: 'custom', message: 'Mint coverage counts must reconcile.' });
  }
  const expected = cap.verifiedMintCount === 0 ? decimal('0')
    : decimal(String(cap.eligibleMintCount)).div(cap.verifiedMintCount).mul(100);
  if (decimal(cap.coveragePct).minus(expected).abs().gt('0.000001')) {
    context.addIssue({ code: 'custom', message: 'Coverage percentage must match mint counts.' });
  }
  if (cap.status === 'complete' && (cap.unavailableMintCount !== 0 || cap.catalogStatus !== 'available')) {
    context.addIssue({ code: 'custom', message: 'Complete cap needs complete mint and catalog coverage.' });
  }
  if ((cap.status === 'unavailable') !== (cap.valueUsd === null)) {
    context.addIssue({ code: 'custom', message: 'Unavailable cap must have a null value; covered cap must have a value.' });
  }
  if (cap.eligibleMintCount === 0 && cap.status !== 'unavailable') {
    context.addIssue({ code: 'custom', message: 'No eligible mint means no covered cap value, not a substitute zero.' });
  }
  if (cap.excluded.length !== cap.unavailableMintCount ||
      new Set(cap.excluded.map(item => item.mint)).size !== cap.excluded.length) {
    context.addIssue({ code: 'custom', message: 'Unavailable mints need unique, explicit exclusion reasons.' });
  }
});

export const OptionalCompanyCapSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('estimated'), valueUsd: MarketNonnegativeDecimalSchema,
    cik: z.string().regex(/^\d{10}$/), isin: MarketIsinSchema,
    shareClass: z.string().min(1).max(80), sharesOutstanding: MarketNonnegativeDecimalSchema,
    sharesEffectiveAt: MarketTimestampSchema, filingAt: MarketTimestampSchema,
    referencePriceUsd: MarketPositiveDecimalSchema, referencePriceAt: MarketTimestampSchema,
    currency: z.literal('USD'), sourceUrl: z.url().startsWith('https://'),
  }).strict(),
  z.object({
    status: z.literal('unavailable'), valueUsd: z.null(),
    reason: z.enum(['missing-cik', 'share-class-unresolved', 'missing-shares', 'stale-shares',
      'corporate-action-unresolved', 'missing-reference-price', 'reference-rights-unverified', 'currency-mismatch']),
  }).strict(),
  z.object({ status: z.literal('not-applicable'), valueUsd: z.null(), reason: z.literal('etf') }).strict(),
]);

export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type SolanaStockVariant = z.infer<typeof SolanaStockVariantSchema>;
export type CanonicalStockAsset = z.infer<typeof CanonicalStockAssetSchema>;
export type MarketIdentityConflict = z.infer<typeof MarketIdentityConflictSchema>;
export type VariantCap = z.infer<typeof VariantCapSchema>;
export type CoveredSolanaCap = z.infer<typeof CoveredSolanaCapSchema>;
export type OptionalCompanyCap = z.infer<typeof OptionalCompanyCapSchema>;
