import 'server-only';
import { z } from 'zod';
import { decimal } from '@/domain/amounts';
import { MarketMintSchema, type SolanaStockVariant } from '@/domain/market-types';
import { VariantTokenObservationSchema } from '@/domain/market-price-policy';
import { type MarketBatchRead } from '@/services/market-snapshot-coordinator';
import { jupiterJson, JupiterApiError } from '@/adapters/jupiter-api/client';

const PriceEntrySchema = z.object({
  usdPrice: z.number().finite().positive(),
  blockId: z.number().int().nonnegative(),
  decimals: z.number().int().min(0).max(30),
  priceChange24h: z.number().finite().nullable().optional(),
}).passthrough();
const ResponseSchema = z.record(z.string(), z.unknown());

/** A keyless, exact-mint Price V3 batch. The shared Jupiter gateway queue
 * enforces the process budget used by the approved legacy worker as well. */
export async function readJupiterPriceV3Batch(input: {
  mints: string[]; variants: ReadonlyMap<string, SolanaStockVariant>; signal: AbortSignal;
}): Promise<MarketBatchRead> {
  if (input.mints.length < 1 || input.mints.length > 50 || new Set(input.mints).size !== input.mints.length) {
    throw new Error('Jupiter Price V3 batch requires 1–50 unique exact mints.');
  }
  for (const mint of input.mints) {
    MarketMintSchema.parse(mint);
    if (!input.variants.has(mint)) throw new Error('Unrecognized exact issuer mint.');
  }
  try {
    const response = await jupiterJson(`/price/v3?ids=${input.mints.join(',')}`, ResponseSchema,
      input.signal, 'keyless-global-market', 'price_worker', { retryRateLimit: false });
    const requested = new Set(input.mints);
    if (Object.keys(response).some(mint => !requested.has(mint))) return { status: 'failed' };
    const retrievedAt = new Date().toISOString();
    const observations = Object.entries(response).flatMap(([mint, value]) => {
      // Price V3 can return an entry containing stockData but no validated
      // usdPrice/blockId. That is not a token-market observation. Omit only
      // this mint; never discard the other valid prices in its 50-ID batch.
      const entry = PriceEntrySchema.safeParse(value);
      if (!entry.success) return [];
      const parsed = entry.data;
      const variant = input.variants.get(mint)!;
      if (variant.decimals !== null && variant.decimals !== parsed.decimals) {
        return [];
      }
      const observation = VariantTokenObservationSchema.safeParse({ mint, provider: 'jupiter-price-v3',
        price: decimal(String(parsed.usdPrice)).toFixed(), currency: 'USD',
        // A Price V3 quote is a token-market price. Never relabel it as the
        // underlying company share or silently apply the issuer multiplier.
        unit: { kind: 'token-unit', id: `token:${mint}` },
        multiplierVersion: variant.multiplier.status === 'current' ? variant.multiplier.current : null,
        providerObservedAt: null, retrievedAt });
      return observation.success ? [observation.data] : [];
    });
    return { status: 'ok', observations };
  } catch (error) {
    if (error instanceof JupiterApiError && error.kind === 'rate-limited') {
      return { status: 'rate-limited', retryAfterMs: Math.min(300_000,
        Math.max(2_100, (error.retryAfterSeconds ?? 3) * 1_000)) };
    }
    return { status: 'failed' };
  }
}
