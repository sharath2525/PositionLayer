import { z } from 'zod';
import { decimal } from './amounts';
import {
  CoveredSolanaCapSchema, MarketMintSchema, MarketNonnegativeDecimalSchema,
  MarketSupplyScopeSchema, MarketTimestampSchema, VariantCapSchema,
  type CoveredSolanaCap, type VariantCap,
} from './market-types';
import {
  resolveVariantTokenPrice, VariantTokenObservationSchema, type VariantTokenObservation,
} from './market-price-policy';
import { UniverseRegistrySchema, type UniverseRegistry } from './universe-registry';

/** Supply evidence is deliberately separate from the issuer's all-chain supply
 * and Solana's raw mint total. Neither proves circulating Solana units. */
export const SolanaSupplyObservationSchema = z.object({
  mint: MarketMintSchema,
  scope: MarketSupplyScopeSchema,
  circulatingBasis: z.enum(['verified-solana-circulating', 'unknown']),
  amount: MarketNonnegativeDecimalSchema,
  unit: z.object({ kind: z.enum(['token-unit', 'display-share']),
    id: z.string().min(1).max(100) }).strict(),
  multiplierVersion: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  observedAt: MarketTimestampSchema,
  retrievedAt: MarketTimestampSchema,
  sourceUrl: z.url().startsWith('https://'),
}).strict();
export type SolanaSupplyObservation = z.infer<typeof SolanaSupplyObservationSchema>;

export const DEFAULT_SUPPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5_000;

type Entry = UniverseRegistry['entries'][number];
type CapReason = Extract<VariantCap, { status: 'unavailable' }>['reason'];

function unavailable(mint: string, reason: CapReason,
  scope: z.infer<typeof MarketSupplyScopeSchema> = 'unknown'): VariantCap {
  return VariantCapSchema.parse({ status: 'unavailable', mint, reason,
    supplyScope: scope, valueUsd: null });
}

/** One exact mint only. A verified, non-overlapping circulating quantity is
 * already denominated in its stated unit; a multiplier is never applied twice. */
export function calculateVariantSolanaCap(input: {
  entry: Entry;
  canonicalVariantCount: number;
  observations: VariantTokenObservation[];
  supplies: SolanaSupplyObservation[];
  now: number;
  priceMaxAgeMs?: number;
  supplyMaxAgeMs?: number;
}): VariantCap {
  const mint = input.entry.variant.mint;
  const supplyRows = input.supplies.map(row => SolanaSupplyObservationSchema.parse(row))
    .filter(row => row.mint === mint).sort((a, b) => b.observedAt.localeCompare(a.observedAt)
      || b.retrievedAt.localeCompare(a.retrievedAt));
  const scope = supplyRows[0]?.scope ?? 'unknown';
  const variant = input.entry.variant;
  if (input.entry.conflicts.length || variant.verification === 'conflicted') {
    return unavailable(mint, 'conflicted-identity', scope);
  }
  if (input.entry.catalogState !== 'active') return unavailable(mint, 'catalog-unconfirmed', scope);
  if (variant.verification !== 'issuer-confirmed') return unavailable(mint, 'unverified-issuer', scope);
  if (variant.eligibility !== 'eligible') return unavailable(mint, 'variant-ineligible', scope);
  if (variant.multiplier.status === 'pending') return unavailable(mint, 'pending-multiplier', scope);
  if (variant.multiplier.status !== 'current' || !variant.multiplier.current) {
    return unavailable(mint, 'multiplier-unresolved', scope);
  }
  if (!supplyRows.length) return unavailable(mint, 'missing-supply');
  const supply = supplyRows[0];
  if (supply.scope !== 'solana-circulating') return unavailable(mint, 'wrong-supply-scope', scope);
  if (supply.circulatingBasis !== 'verified-solana-circulating') {
    return unavailable(mint, 'unknown-circulating-basis', scope);
  }
  const sameInstant = supplyRows.filter(row => row.observedAt === supply.observedAt);
  if (sameInstant.some(row => row.amount !== supply.amount || row.scope !== supply.scope
      || row.circulatingBasis !== supply.circulatingBasis
      || row.unit.kind !== supply.unit.kind || row.unit.id !== supply.unit.id
      || row.multiplierVersion !== supply.multiplierVersion)) {
    return unavailable(mint, 'conflicting-supply', scope);
  }
  const supplyMaxAge = input.supplyMaxAgeMs ?? DEFAULT_SUPPLY_MAX_AGE_MS;
  if (!Number.isInteger(supplyMaxAge) || supplyMaxAge <= 0) throw new Error('Invalid supply age limit.');
  const supplyAge = input.now - Date.parse(supply.observedAt);
  if (supplyAge < -FUTURE_TOLERANCE_MS) return unavailable(mint, 'future-dated', scope);
  if (supplyAge > supplyMaxAge) return unavailable(mint, 'stale-supply', scope);
  if (supply.multiplierVersion !== variant.multiplier.current) {
    return unavailable(mint, 'unit-mismatch', scope);
  }
  const price = resolveVariantTokenPrice({ variant, catalogState: input.entry.catalogState,
    conflicts: input.entry.conflicts.length, canonicalVariantCount: input.canonicalVariantCount,
    observations: input.observations.filter(row => row.mint === mint),
    now: input.now, maxAgeMs: input.priceMaxAgeMs });
  if (price.status === 'blocked') {
    const mapped: CapReason = price.reason === 'stale-price' ? 'stale-price'
      : price.reason === 'invalid-price' ? 'invalid-price'
        : price.reason === 'currency-mismatch' ? 'currency-mismatch'
          : price.reason === 'future-dated' ? 'future-dated'
            : price.reason === 'unit-mismatch' || price.reason === 'multiplier-mismatch' ? 'unit-mismatch'
              : price.reason === 'pending-multiplier' ? 'pending-multiplier'
                : price.reason === 'multiplier-unresolved' ? 'multiplier-unresolved'
                  : 'missing-price';
    return unavailable(mint, mapped, scope);
  }
  if (supply.unit.kind !== price.unit.kind || supply.unit.id !== price.unit.id
      || supply.multiplierVersion !== price.multiplierVersion) {
    return unavailable(mint, 'unit-mismatch', scope);
  }
  const valueUsd = decimal(supply.amount).mul(price.priceUsd).toFixed();
  return VariantCapSchema.parse({ status: 'eligible', mint, supplyScope: 'solana-circulating',
    supply: supply.amount, supplyUnit: supply.unit.id, supplyObservedAt: supply.observedAt,
    supplySourceUrl: supply.sourceUrl, tokenPriceUsd: price.priceUsd, priceUnit: price.unit.id,
    priceObservedAt: price.providerObservedAt, priceProvider: price.provider,
    multiplier: variant.multiplier.current, valueUsd });
}

/** A covered sum, not a whole-market headline or company capitalization. */
export function calculateCoveredSolanaCap(input: {
  registry: UniverseRegistry;
  observations: VariantTokenObservation[];
  supplies: SolanaSupplyObservation[];
  now: number;
  priceMaxAgeMs?: number;
  supplyMaxAgeMs?: number;
}): { summary: CoveredSolanaCap; variants: VariantCap[] } {
  const registry = UniverseRegistrySchema.parse(input.registry);
  const observations = input.observations.map(row => VariantTokenObservationSchema.parse(row));
  const supplyByMint = new Map<string, SolanaSupplyObservation[]>();
  for (const row of input.supplies) {
    const valid = SolanaSupplyObservationSchema.parse(row);
    supplyByMint.set(valid.mint, [...(supplyByMint.get(valid.mint) ?? []), valid]);
  }
  const priceByMint = new Map<string, VariantTokenObservation[]>();
  for (const row of observations) priceByMint.set(row.mint, [...(priceByMint.get(row.mint) ?? []), row]);
  const countByMint = new Map(registry.assets.flatMap(asset => asset.variantMints.map(mint => [mint, asset.variantMints.length] as const)));
  const inScope = registry.entries.filter(entry => entry.catalogState !== 'delisted'
    && entry.variant.verification === 'issuer-confirmed');
  const variants = inScope.map(entry => calculateVariantSolanaCap({ entry,
    canonicalVariantCount: countByMint.get(entry.variant.mint) ?? 1,
    observations: priceByMint.get(entry.variant.mint) ?? [],
    supplies: supplyByMint.get(entry.variant.mint) ?? [], now: input.now,
    priceMaxAgeMs: input.priceMaxAgeMs, supplyMaxAgeMs: input.supplyMaxAgeMs }));
  const eligible = variants.filter((item): item is Extract<VariantCap, { status: 'eligible' }> => item.status === 'eligible');
  const excluded = variants.filter((item): item is Extract<VariantCap, { status: 'unavailable' }> => item.status === 'unavailable')
    .map(item => ({ mint: item.mint, reason: item.reason }));
  const catalogStatus = registry.status === 'complete' && !registry.truncation.truncated
    && registry.quarantine.length === 0 ? 'available' : 'stale';
  const oldestInput = eligible.flatMap(item => [item.supplyObservedAt, item.priceObservedAt]).sort()[0] ?? null;
  const summary = CoveredSolanaCapSchema.parse({
    status: eligible.length === 0 ? 'unavailable'
      : excluded.length === 0 && catalogStatus === 'available' ? 'complete' : 'partial',
    valueUsd: eligible.length ? eligible.reduce((sum, item) => sum.plus(item.valueUsd), decimal('0')).toFixed() : null,
    eligibleMintCount: eligible.length, unavailableMintCount: excluded.length,
    verifiedMintCount: variants.length,
    coveragePct: variants.length ? decimal(String(eligible.length)).div(variants.length).mul(100).toFixed() : '0',
    catalogStatus, oldestInputAt: oldestInput, excluded,
  });
  return { summary, variants };
}
