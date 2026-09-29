import { z } from 'zod';
import { MarketMintSchema, MarketTimestampSchema } from './market-types';

// Each field owns its timestamp. A successful token quote cannot freshen an
// omitted reference, liquidity or supply value retained from an earlier read.
const FieldSchema = z.object({ value: z.number().finite(), retrievedAt: MarketTimestampSchema,
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), observedAt: MarketTimestampSchema.nullable().optional() }).strict();
const PositiveFieldSchema = FieldSchema.refine(field => field.value > 0);
const NonnegativeFieldSchema = FieldSchema.refine(field => field.value >= 0);
export const MarketEnrichmentSchema = z.object({
  mint: MarketMintSchema, source: z.literal('jupiter-price-v3'),
  referencePrice: PositiveFieldSchema.nullable(), companyCap: PositiveFieldSchema.nullable(),
  liquidity: NonnegativeFieldSchema.nullable(), change24h: FieldSchema.nullable(),
  multiplier: PositiveFieldSchema.nullable(), circulatingPrescaled: NonnegativeFieldSchema.nullable(),
  totalPrescaled: NonnegativeFieldSchema.nullable(),
  tokenCreatedAt: MarketTimestampSchema.nullable().optional(),
  pendingMultiplier: PositiveFieldSchema.nullable().optional(), multiplierEffectiveAt: MarketTimestampSchema.nullable().optional(),
}).strict();
export type MarketEnrichment = z.infer<typeof MarketEnrichmentSchema>;
export type MarketField = z.infer<typeof FieldSchema>;
const keys = ['referencePrice', 'companyCap', 'liquidity', 'change24h', 'multiplier',
  'circulatingPrescaled', 'totalPrescaled', 'pendingMultiplier'] as const;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Supplementary provider fields are validated independently of usdPrice.
 * stockData currency and supply scope are not inferred from the ticker. */
export function parseMarketEnrichment(mint: string, raw: unknown, retrievedAt: string): MarketEnrichment | null {
  const entry = object(raw), stock = object(entry.stockData), scaled = object(entry.scaledUiConfig);
  const currency = typeof stock.currency === 'string' && /^[A-Z]{3}$/.test(stock.currency) ? stock.currency : null;
  const timestamp = (value: unknown) => typeof value === 'string'
    && MarketTimestampSchema.safeParse(value).success && Date.parse(value) <= Date.parse(retrievedAt) + 5_000 ? value : null;
  const field = (value: unknown, unit: string | null, positive = false): MarketField | null =>
    typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
      ? { value, currency: unit, retrievedAt } : null;
  const result: MarketEnrichment = { mint, source: 'jupiter-price-v3',
    tokenCreatedAt: timestamp(entry.createdAt),
    referencePrice: field(stock.price, currency, true), companyCap: field(stock.mcap, currency, true),
    liquidity: field(entry.liquidity, 'USD'),
    change24h: typeof entry.priceChange24h === 'number' && Number.isFinite(entry.priceChange24h)
      ? { value: entry.priceChange24h, currency: null, retrievedAt } : null,
    multiplier: field(scaled.multiplier, null, true),
    circulatingPrescaled: field(scaled.circSupplyPrescaled, null), totalPrescaled: field(scaled.totalSupplyPrescaled, null),
    pendingMultiplier: field(scaled.newMultiplier, null, true),
    multiplierEffectiveAt: typeof scaled.newMultiplierEffectiveAt === 'string'
      && MarketTimestampSchema.safeParse(scaled.newMultiplierEffectiveAt).success ? scaled.newMultiplierEffectiveAt : null };
  if (result.referencePrice) result.referencePrice.observedAt = timestamp(stock.updatedAt);
  if (result.companyCap) result.companyCap.observedAt = timestamp(stock.updatedAt);
  return keys.some(key => result[key] != null) ? MarketEnrichmentSchema.parse(result) : null;
}

export function mergeMarketEnrichment(current: MarketEnrichment | undefined, previous: MarketEnrichment | undefined) {
  if (!current) return previous;
  if (!previous) return current;
  const merged = { ...current };
  merged.tokenCreatedAt ??= previous.tokenCreatedAt ?? null;
  for (const key of keys) merged[key] ??= previous[key] ?? null;
  if (!current.pendingMultiplier && previous.pendingMultiplier) merged.multiplierEffectiveAt = previous.multiplierEffectiveAt;
  return merged;
}

export function referenceFreshness(field: MarketField | null | undefined, now = Date.now()) {
  if (!field) return 'Unavailable';
  const age = now - Date.parse(field.observedAt ?? field.retrievedAt);
  return age < 0 || age > 86_400_000 ? 'Stale' : age > 120_000 ? 'Delayed' : 'Retrieved recently';
}
