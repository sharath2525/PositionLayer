import { z } from 'zod';
import { decimal } from './amounts';

const DecimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const TimestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO timestamp');

export const MarketFreshnessSchema = z.enum(['LIVE', 'DELAYED', 'STALE', 'UNAVAILABLE']);
export const MarketUpdateFailureSchema = z.object({
  kind: z.enum(['omitted', 'provider-error', 'decimals-mismatch']),
  at: TimestampSchema,
  message: z.string().min(1).max(160),
}).strict();

export const MarketObservationSchema = z.object({
  source: z.literal('jupiter-price-v3'),
  mint: z.string().min(32).max(64),
  currency: z.literal('USD'),
  priceUsd: DecimalStringSchema.nullable(),
  lastKnownPriceUsd: DecimalStringSchema.nullable(),
  priceChange24hPct: DecimalStringSchema.nullable(),
  blockId: z.number().int().nonnegative().nullable(),
  decimals: z.number().int().min(0).max(30).nullable(),
  retrievedAt: TimestampSchema.nullable(),
  freshness: MarketFreshnessSchema,
  eligibleForSensitiveUse: z.boolean(),
  updateFailure: MarketUpdateFailureSchema.nullable(),
}).strict();

export const PoolObservationSchema = z.object({
  source: z.enum(['meteora-dlmm', 'meteora-damm-v2']),
  poolAddress: z.string().min(32).max(64),
  stockMint: z.string().min(32).max(64),
  quoteMint: z.string().min(32).max(64),
  quoteSymbol: z.string().min(1).max(16),
  orientation: z.enum(['stock-x', 'stock-y']),
  pairPrice: DecimalStringSchema,
  priceUsd: DecimalStringSchema,
  tvlUsd: DecimalStringSchema,
  liquidityUsd: DecimalStringSchema,
  volume24hUsd: DecimalStringSchema.nullable(),
  fees24hUsd: DecimalStringSchema.nullable(),
  blacklisted: z.literal(false),
  providerObservedAt: TimestampSchema.nullable(),
  retrievedAt: TimestampSchema,
  sourceUrl: z.string().url().regex(/^https:\/\//),
}).strict();

export const MarketComparisonReasonSchema = z.enum([
  'feature-disabled', 'no-jupiter-price', 'jupiter-not-live', 'no-meteora-pool',
  'exact-mint-mismatch', 'currency-mismatch', 'unit-mismatch', 'multiplier-unresolved',
  'quote-conversion-unverified', 'orientation-unresolved', 'meteora-stale',
  'low-liquidity', 'invalid-price',
]);

export const MarketSourceComparisonSchema = z.object({
  status: z.enum(['AGREE', 'DIVERGED', 'NOT_COMPARABLE']),
  reason: MarketComparisonReasonSchema.nullable(),
  differencePct: DecimalStringSchema.nullable(),
  divergenceThresholdPct: DecimalStringSchema,
  jupiterPriceUsd: DecimalStringSchema.nullable(),
  meteoraPriceUsd: DecimalStringSchema.nullable(),
}).strict();

export const MarketEvidenceSchema = z.object({
  selectedSource: z.enum(['jupiter-price-v3', 'none']),
  selectedFreshness: MarketFreshnessSchema,
  lastSuccessfulMarketUpdate: TimestampSchema.nullable(),
  meteoraPool: PoolObservationSchema.nullable(),
  comparison: MarketSourceComparisonSchema,
  meteoraFallbackActive: z.literal(false),
}).strict();

export const ProviderFailureSchema = z.object({
  provider: z.enum(['JUPITER', 'METEORA']),
  kind: z.enum(['aborted', 'rate-limited', 'timeout', 'http', 'invalid-json', 'schema', 'normalization', 'network']),
  operation: z.string().min(1).max(64),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  retryAfterSeconds: z.number().int().nonnegative().nullable(),
  message: z.string().min(1).max(160),
}).strict();

export type MarketFreshness = z.infer<typeof MarketFreshnessSchema>;
export type MarketUpdateFailure = z.infer<typeof MarketUpdateFailureSchema>;
export type MarketObservation = z.infer<typeof MarketObservationSchema>;
export type PoolObservation = z.infer<typeof PoolObservationSchema>;
export type MarketSourceComparison = z.infer<typeof MarketSourceComparisonSchema>;
export type MarketEvidence = z.infer<typeof MarketEvidenceSchema>;
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;

function positiveEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function marketFreshnessPolicy() {
  const liveMs = positiveEnv('MARKET_LIVE_MS', 45_000);
  const delayedMs = Math.max(liveMs, positiveEnv('MARKET_DELAYED_MS', 120_000));
  const staleMs = Math.max(delayedMs, positiveEnv('MARKET_STALE_MS', 600_000));
  return { liveMs, delayedMs, staleMs };
}

export function marketFreshness(retrievedAt: string | null, now = Date.now()): MarketFreshness {
  if (!retrievedAt) return 'UNAVAILABLE';
  const age = Math.max(0, now - Date.parse(retrievedAt));
  const policy = marketFreshnessPolicy();
  if (age <= policy.liveMs) return 'LIVE';
  if (age <= policy.delayedMs) return 'DELAYED';
  if (age <= policy.staleMs) return 'STALE';
  return 'UNAVAILABLE';
}

export function projectJupiterObservation(input: {
  mint: string;
  priceUsd: string | null;
  priceChange24hPct: string | null;
  blockId: number | null;
  decimals: number | null;
  retrievedAt: string | null;
  updateFailure?: MarketUpdateFailure | null;
}, now = Date.now()): MarketObservation {
  const freshness = marketFreshness(input.retrievedAt, now);
  const lastKnownPriceUsd = input.priceUsd;
  return MarketObservationSchema.parse({
    source: 'jupiter-price-v3', mint: input.mint, currency: 'USD',
    priceUsd: freshness === 'UNAVAILABLE' ? null : input.priceUsd,
    lastKnownPriceUsd, priceChange24hPct: input.priceChange24hPct,
    blockId: input.blockId, decimals: input.decimals, retrievedAt: input.retrievedAt,
    freshness, eligibleForSensitiveUse: freshness === 'LIVE',
    updateFailure: input.updateFailure ?? null,
  });
}

export function marketDivergenceThresholdPct() {
  return decimal(String(positiveEnv('MARKET_DIVERGENCE_THRESHOLD_PCT', 5))).toFixed();
}

export function compareMarketSources(input: {
  enabled: boolean;
  jupiter: MarketObservation;
  meteora: PoolObservation | null;
  exactMint: boolean;
  sameCurrency: boolean;
  sameDisplayUnit: boolean;
  multiplierResolved: boolean;
  quoteConversionVerified: boolean;
  orientationResolved: boolean;
  minimumLiquidityUsd: string;
  now?: number;
}): MarketSourceComparison {
  const threshold = marketDivergenceThresholdPct();
  const notComparable = (reason: z.infer<typeof MarketComparisonReasonSchema>) => MarketSourceComparisonSchema.parse({
    status: 'NOT_COMPARABLE', reason, differencePct: null, divergenceThresholdPct: threshold,
    jupiterPriceUsd: input.jupiter.priceUsd, meteoraPriceUsd: input.meteora?.priceUsd ?? null,
  });
  if (!input.enabled) return notComparable('feature-disabled');
  if (!input.jupiter.priceUsd) return notComparable('no-jupiter-price');
  if (input.jupiter.freshness !== 'LIVE') return notComparable('jupiter-not-live');
  if (!input.meteora) return notComparable('no-meteora-pool');
  if (!input.exactMint || input.meteora.stockMint !== input.jupiter.mint) return notComparable('exact-mint-mismatch');
  if (!input.sameCurrency) return notComparable('currency-mismatch');
  if (!input.sameDisplayUnit) return notComparable('unit-mismatch');
  if (!input.multiplierResolved) return notComparable('multiplier-unresolved');
  if (!input.quoteConversionVerified) return notComparable('quote-conversion-unverified');
  if (!input.orientationResolved) return notComparable('orientation-unresolved');
  const poolFreshness = marketFreshness(input.meteora.retrievedAt, input.now ?? Date.now());
  if (poolFreshness !== 'LIVE') return notComparable('meteora-stale');
  if (decimal(input.meteora.liquidityUsd).lt(input.minimumLiquidityUsd)) return notComparable('low-liquidity');
  const left = decimal(input.jupiter.priceUsd);
  const right = decimal(input.meteora.priceUsd);
  if (left.lte(0) || right.lte(0)) return notComparable('invalid-price');
  const differencePct = left.minus(right).abs().div(left.plus(right).div(2)).mul(100).toDecimalPlaces(8).toFixed();
  return MarketSourceComparisonSchema.parse({
    status: decimal(differencePct).gt(threshold) ? 'DIVERGED' : 'AGREE', reason: null,
    differencePct, divergenceThresholdPct: threshold,
    jupiterPriceUsd: input.jupiter.priceUsd, meteoraPriceUsd: input.meteora.priceUsd,
  });
}
