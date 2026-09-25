import { z } from 'zod';
import { decimal } from './amounts';
import { MarketMintSchema, MarketTimestampSchema, SolanaStockVariantSchema } from './market-types';
import { UniverseRegistrySchema, type UniverseRegistry } from './universe-registry';

const DecimalInputSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const UnitSchema = z.object({ kind: z.enum(['token-unit', 'display-share', 'unknown']),
  id: z.string().min(1).max(100).nullable() }).strict();

/** A token-market observation only. Issuer and company marks have a separate type. */
export const VariantTokenObservationSchema = z.object({
  mint: MarketMintSchema,
  provider: z.literal('jupiter-price-v3'),
  price: DecimalInputSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: UnitSchema,
  multiplierVersion: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  providerObservedAt: MarketTimestampSchema.nullable(),
  retrievedAt: MarketTimestampSchema.nullable(),
}).strict();
export const MarketReferenceQuoteSchema = z.object({
  kind: z.enum(['issuer-indicative', 'underlying-company', 'jupiter-tokens-v2-reference']),
  price: DecimalInputSchema.refine(value => decimal(value).gt(0)),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitDescription: z.string().min(1).max(100),
  retrievedAt: MarketTimestampSchema,
  displayOnly: z.literal(true),
}).strict();
export const PriceBlockerSchema = z.enum([
  'asset-not-found', 'catalog-unconfirmed', 'identity-conflict', 'issuer-unverified', 'variant-ineligible',
  'no-token-observation', 'invalid-price', 'currency-mismatch', 'unit-mismatch',
  'pending-multiplier', 'multiplier-unresolved', 'multiplier-mismatch',
  'missing-observation-time', 'future-dated', 'stale-price',
  'issuer-halted',
]);
export const DisplayTokenPriceSchema = z.object({
  status: z.enum(['LIVE', 'DELAYED', 'STALE', 'UNAVAILABLE']),
  mint: MarketMintSchema, priceUsd: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  observedAt: MarketTimestampSchema.nullable(), retrievedAt: MarketTimestampSchema.nullable(),
  reason: PriceBlockerSchema.nullable(), source: z.literal('jupiter-price-v3').nullable(),
  eligibleForSensitiveUse: z.literal(false),
}).strict().superRefine((value, context) => {
  const available = value.status !== 'UNAVAILABLE';
  if (available !== (value.priceUsd !== null && value.observedAt !== null
      && value.retrievedAt !== null && value.source !== null && value.reason === null)) {
    context.addIssue({ code: 'custom', message: 'Display price state and evidence must agree.' });
  }
  if (!available && (value.priceUsd !== null || value.reason === null)) {
    context.addIssue({ code: 'custom', message: 'Unavailable display prices need a reason and no value.' });
  }
  if (value.priceUsd !== null && decimal(value.priceUsd).lte(0)) {
    context.addIssue({ code: 'custom', message: 'A displayed token price must be positive.' });
  }
});
export type DisplayTokenPrice = z.infer<typeof DisplayTokenPriceSchema>;
export const VariantPriceDecisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('eligible'), mint: MarketMintSchema,
    priceUsd: z.string().regex(/^\d+(?:\.\d+)?$/), unit: UnitSchema,
    multiplierVersion: z.string().nullable(), providerObservedAt: MarketTimestampSchema,
    retrievedAt: MarketTimestampSchema, ageMs: z.number().int().nonnegative(),
    provider: z.literal('jupiter-price-v3'), eligibleForSensitiveUse: z.literal(true),
  }).strict(),
  z.object({ status: z.literal('blocked'), mint: MarketMintSchema, reason: PriceBlockerSchema }).strict(),
]);
const ComparisonSchema = z.object({
  status: z.enum(['AGREE', 'DIVERGED', 'NOT_COMPARABLE']),
  reason: z.enum(['single-variant', 'no-second-eligible-price', 'unit-mismatch', 'currency-mismatch',
    'multiplier-unresolved', 'stale-observation']).nullable(),
  differencePct: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  comparedMints: z.array(MarketMintSchema).max(2000),
}).strict();
export const ResolvedCanonicalPriceSchema = z.object({
  assetId: z.string().min(1).max(160),
  status: z.enum(['selected', 'unavailable']),
  selected: VariantPriceDecisionSchema.options[0].nullable(),
  reason: PriceBlockerSchema.nullable(),
  candidates: z.array(VariantPriceDecisionSchema).max(2000),
  comparison: ComparisonSchema,
  referenceQuotes: z.array(MarketReferenceQuoteSchema).max(12),
}).strict().superRefine((result, context) => {
  if ((result.status === 'selected') !== (result.selected !== null)) {
    context.addIssue({ code: 'custom', message: 'A selected price needs a selected variant; unavailable cannot carry one.' });
  }
  if ((result.status === 'unavailable') !== (result.reason !== null)) {
    context.addIssue({ code: 'custom', message: 'An unavailable price needs a typed reason.' });
  }
});

export type VariantTokenObservation = z.infer<typeof VariantTokenObservationSchema>;
export type VariantPriceDecision = z.infer<typeof VariantPriceDecisionSchema>;
export type ResolvedCanonicalPrice = z.infer<typeof ResolvedCanonicalPriceSchema>;
export type PriceBlocker = z.infer<typeof PriceBlockerSchema>;
export type MarketReferenceQuote = z.infer<typeof MarketReferenceQuoteSchema>;

export const DEFAULT_TOKEN_PRICE_MAX_AGE_MS = 45_000;
const FUTURE_TOLERANCE_MS = 5_000;
const DIVERGENCE_THRESHOLD_PCT = '5';

/** Catalog-side admission to the read-only price queue, independent of the
 * narrower valuation gate below. Jupiter discovery tags cannot satisfy it. */
export function canQueryExactIssuerPrice(entry: UniverseRegistry['entries'][number]) {
  return entry.catalogState === 'active' && entry.conflicts.length === 0
    && entry.variant.verification === 'issuer-confirmed' && entry.variant.tradingHalted !== true;
}

/** A distinct display-only projection. It never satisfies the strict valuation,
 * cap, comparison or risk resolver, and keeps the original observation time. */
export function resolveDisplayTokenPrice(input: {
  variant: z.infer<typeof SolanaStockVariantSchema>;
  catalogState: UniverseRegistry['entries'][number]['catalogState'];
  conflicts: number; observation?: VariantTokenObservation | null; now: number;
}): DisplayTokenPrice {
  const variant = SolanaStockVariantSchema.parse(input.variant);
  const unavailable = (reason: PriceBlocker) => DisplayTokenPriceSchema.parse({ status: 'UNAVAILABLE',
    mint: variant.mint, priceUsd: null, observedAt: null, retrievedAt: null,
    reason, source: null, eligibleForSensitiveUse: false });
  if (input.conflicts > 0) return unavailable('identity-conflict');
  if (input.catalogState !== 'active') return unavailable('catalog-unconfirmed');
  if (variant.verification !== 'issuer-confirmed') return unavailable('issuer-unverified');
  if (variant.tradingHalted === true) return unavailable('issuer-halted');
  if (!input.observation) return unavailable('no-token-observation');
  const parsed = VariantTokenObservationSchema.safeParse(input.observation);
  if (!parsed.success || parsed.data.mint !== variant.mint) return unavailable('invalid-price');
  const item = parsed.data;
  if (!item.price || decimal(item.price).lte(0)) return unavailable('invalid-price');
  if (item.currency !== 'USD') return unavailable('currency-mismatch');
  if (item.unit.kind !== 'token-unit' || item.unit.id !== `token:${variant.mint}`) return unavailable('unit-mismatch');
  const time = observedAt(item);
  if (!time || !item.retrievedAt) return unavailable('missing-observation-time');
  const age = input.now - Date.parse(time);
  if (age < -FUTURE_TOLERANCE_MS) return unavailable('future-dated');
  if (age > 600_000) return unavailable('stale-price');
  return DisplayTokenPriceSchema.parse({
    status: age <= 45_000 ? 'LIVE' : age <= 120_000 ? 'DELAYED' : 'STALE',
    mint: variant.mint, priceUsd: decimal(item.price).toFixed(), observedAt: time,
    retrievedAt: item.retrievedAt, reason: null, source: 'jupiter-price-v3', eligibleForSensitiveUse: false,
  });
}

function observedAt(observation: VariantTokenObservation) {
  // Jupiter V3 does not provide a wall-clock trade timestamp in the current
  // adapter. Its original successful retrieval time is the observation time.
  return observation.providerObservedAt ?? observation.retrievedAt;
}

export function resolveVariantTokenPrice(input: {
  variant: z.infer<typeof SolanaStockVariantSchema>;
  catalogState: UniverseRegistry['entries'][number]['catalogState'];
  conflicts: number;
  observations: VariantTokenObservation[];
  canonicalVariantCount: number;
  now: number;
  maxAgeMs?: number;
}): VariantPriceDecision {
  const variant = SolanaStockVariantSchema.parse(input.variant);
  const blocked = (reason: PriceBlocker) => VariantPriceDecisionSchema.parse({ status: 'blocked', mint: variant.mint, reason });
  if (input.conflicts > 0) return blocked('identity-conflict');
  if (input.catalogState !== 'active') return blocked('catalog-unconfirmed');
  if (variant.verification !== 'issuer-confirmed') return blocked('issuer-unverified');
  if (variant.eligibility !== 'eligible') return blocked('variant-ineligible');
  if (variant.multiplier.status === 'pending') return blocked('pending-multiplier');
  let malformedExactMint = false;
  const matches = input.observations.flatMap(item => {
    if (item.mint !== variant.mint) return [];
    const parsed = VariantTokenObservationSchema.safeParse(item);
    if (!parsed.success) { malformedExactMint = true; return []; }
    return [parsed.data];
  })
    .sort((a, b) => (observedAt(b) ?? '').localeCompare(observedAt(a) ?? '')
      || (b.retrievedAt ?? '').localeCompare(a.retrievedAt ?? ''));
  if (matches.length === 0) return blocked(malformedExactMint ? 'invalid-price' : 'no-token-observation');
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_TOKEN_PRICE_MAX_AGE_MS;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid token-price age limit.');
  let firstFailure: PriceBlocker = malformedExactMint ? 'invalid-price' : 'no-token-observation';
  for (const item of matches) {
    const fail = (reason: PriceBlocker) => { if (firstFailure === 'no-token-observation') firstFailure = reason; };
    if (item.price === null) { fail('no-token-observation'); continue; }
    if (decimal(item.price).lte(0)) { fail('invalid-price'); continue; }
    if (item.currency !== 'USD') { fail('currency-mismatch'); continue; }
    const time = observedAt(item);
    if (!time || !item.retrievedAt) { fail('missing-observation-time'); continue; }
    const age = input.now - Date.parse(time);
    if (age < -FUTURE_TOLERANCE_MS) { fail('future-dated'); continue; }
    if (age > maxAgeMs) { fail('stale-price'); continue; }
    if (input.canonicalVariantCount > 1) {
      if (variant.economicUnit.kind !== 'display-share' || item.unit.kind !== 'display-share'
          || item.unit.id !== variant.economicUnit.unitId) { fail('unit-mismatch'); continue; }
    } else if (item.unit.kind === 'token-unit') {
      if (item.unit.id !== `token:${variant.mint}`) { fail('unit-mismatch'); continue; }
    } else if (item.unit.kind !== 'display-share' || variant.economicUnit.kind !== 'display-share'
        || item.unit.id !== variant.economicUnit.unitId) { fail('unit-mismatch'); continue; }
    if (variant.multiplier.status === 'current') {
      if (item.multiplierVersion !== variant.multiplier.current) { fail('multiplier-mismatch'); continue; }
    } else if (item.unit.kind === 'display-share' || input.canonicalVariantCount > 1) {
      fail('multiplier-unresolved'); continue;
    }
    return VariantPriceDecisionSchema.parse({ status: 'eligible', mint: variant.mint,
      priceUsd: decimal(item.price).toFixed(), unit: item.unit,
      multiplierVersion: item.multiplierVersion,
      providerObservedAt: time, retrievedAt: item.retrievedAt,
      ageMs: Math.max(0, age), provider: item.provider, eligibleForSensitiveUse: true });
  }
  return blocked(firstFailure);
}

function comparison(candidates: VariantPriceDecision[]): z.infer<typeof ComparisonSchema> {
  const eligible = candidates.filter((item): item is Extract<VariantPriceDecision, { status: 'eligible' }> => item.status === 'eligible');
  if (candidates.length <= 1) return ComparisonSchema.parse({ status: 'NOT_COMPARABLE', reason: 'single-variant',
    differencePct: null, comparedMints: [] });
  if (eligible.length < 2) {
    const blocker = candidates.find(item => item.status === 'blocked');
    const reason = blocker?.status === 'blocked' && blocker.reason === 'currency-mismatch' ? 'currency-mismatch'
      : blocker?.status === 'blocked' && blocker.reason === 'unit-mismatch' ? 'unit-mismatch'
        : blocker?.status === 'blocked' && ['pending-multiplier', 'multiplier-unresolved', 'multiplier-mismatch'].includes(blocker.reason)
          ? 'multiplier-unresolved' : blocker?.status === 'blocked' && blocker.reason === 'stale-price'
            ? 'stale-observation' : 'no-second-eligible-price';
    return ComparisonSchema.parse({ status: 'NOT_COMPARABLE', reason, differencePct: null, comparedMints: [] });
  }
  const units = new Set(eligible.map(item => `${item.unit.kind}:${item.unit.id}`));
  if (units.size !== 1 || eligible[0].unit.kind !== 'display-share') return ComparisonSchema.parse({
    status: 'NOT_COMPARABLE', reason: 'unit-mismatch', differencePct: null, comparedMints: [],
  });
  const multipliers = new Set(eligible.map(item => item.multiplierVersion));
  if (multipliers.size !== 1 || multipliers.has(null)) return ComparisonSchema.parse({
    status: 'NOT_COMPARABLE', reason: 'multiplier-unresolved', differencePct: null, comparedMints: [],
  });
  // For positive prices, the maximum symmetric percent spread is min versus
  // max. This remains linear even for a 2,000-variant canonical asset.
  const prices = eligible.map(item => decimal(item.priceUsd));
  const low = prices.reduce((a, b) => a.lt(b) ? a : b);
  const high = prices.reduce((a, b) => a.gt(b) ? a : b);
  const largest = high.minus(low).div(high.plus(low).div(2)).mul(100);
  const differencePct = largest.toDecimalPlaces(8).toFixed();
  return ComparisonSchema.parse({ status: largest.gt(DIVERGENCE_THRESHOLD_PCT) ? 'DIVERGED' : 'AGREE',
    reason: null, differencePct, comparedMints: eligible.map(item => item.mint).sort() });
}

/** Stable policy: issuer-confirmed active variants, same economic unit, live USD
 * Jupiter V3 observations, freshest original observation, then lexical mint.
 * Reference/issuer/company quotes are returned as context and never selected. */
export function resolveCanonicalTokenPrice(input: {
  registry: UniverseRegistry;
  assetId: string;
  observations: VariantTokenObservation[];
  referenceQuotes?: MarketReferenceQuote[];
  now: number;
  maxAgeMs?: number;
}): ResolvedCanonicalPrice {
  const registry = UniverseRegistrySchema.parse(input.registry);
  // Optional context cannot take down an otherwise valid token-price read.
  const references = (input.referenceQuotes ?? []).flatMap(item => {
    const parsed = MarketReferenceQuoteSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const asset = registry.assets.find(item => item.id === input.assetId);
  if (!asset) return ResolvedCanonicalPriceSchema.parse({ assetId: input.assetId,
    status: 'unavailable', selected: null, reason: 'asset-not-found', candidates: [],
    comparison: comparison([]), referenceQuotes: references });
  const entries = new Map(registry.entries.map(entry => [entry.variant.mint, entry]));
  const observations = new Map<string, VariantTokenObservation[]>();
  for (const row of input.observations) observations.set(row.mint, [...(observations.get(row.mint) ?? []), row]);
  const decisions = asset.variantMints.map(mint => {
    const entry = entries.get(mint)!;
    return resolveVariantTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
      conflicts: entry.conflicts.length, observations: observations.get(mint) ?? [],
      canonicalVariantCount: asset.variantMints.length, now: input.now, maxAgeMs: input.maxAgeMs });
  });
  const eligible = decisions.filter((item): item is Extract<VariantPriceDecision, { status: 'eligible' }> => item.status === 'eligible')
    .sort((a, b) => a.ageMs - b.ageMs || a.mint.localeCompare(b.mint));
  const selected = eligible[0] ?? null;
  const firstBlocked = decisions.find(item => item.status === 'blocked');
  return ResolvedCanonicalPriceSchema.parse({ assetId: asset.id,
    status: selected ? 'selected' : 'unavailable', selected,
    reason: selected ? null : firstBlocked?.status === 'blocked' ? firstBlocked.reason : 'no-token-observation',
    candidates: decisions, comparison: comparison(decisions), referenceQuotes: references });
}
