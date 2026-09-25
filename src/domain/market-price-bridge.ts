import { StockMarketRecordSchema, type StockMarketRecord } from './stocks';
import {
  MarketReferenceQuoteSchema, VariantTokenObservationSchema,
  type MarketReferenceQuote, type VariantTokenObservation,
} from './market-price-policy';

/** Phase 4 shadow bridge. It reads the legacy record; it never rewrites the
 * live record, worker, public response, or portfolio valuation. */
export function bridgeLegacyMarketRecord(input: StockMarketRecord): {
  observation: VariantTokenObservation | null;
  references: MarketReferenceQuote[];
} {
  const record = StockMarketRecordSchema.parse(input);
  const market = record.marketObservation;
  const observation = market ? VariantTokenObservationSchema.parse({
    mint: record.mint, provider: 'jupiter-price-v3',
    price: market.lastKnownPriceUsd,
    currency: market.currency,
    unit: { kind: 'token-unit', id: `token:${record.mint}` },
    multiplierVersion: record.intelligence?.multiplier.status === 'current'
      ? record.intelligence.multiplier.current : null,
    providerObservedAt: null,
    // This is the original successful Price V3 retrieval time, not the time of
    // this projection or a failed/omitted retry.
    retrievedAt: market.retrievedAt,
  }) : null;
  const references: MarketReferenceQuote[] = [];
  if (record.referencePriceUsd !== null && record.referencePriceUsd !== undefined
      && record.referencePriceRetrievedAt) {
    const reference = MarketReferenceQuoteSchema.safeParse({
      kind: 'jupiter-tokens-v2-reference', price: record.referencePriceUsd,
      currency: 'USD', unitDescription: 'Token reference; display only',
      retrievedAt: record.referencePriceRetrievedAt, displayOnly: true,
    });
    if (reference.success) references.push(reference.data);
  }
  if (record.intelligence?.issuerIndicativePriceUsd && record.intelligence.issuerPriceRetrievedAt) {
    const reference = MarketReferenceQuoteSchema.safeParse({
      kind: 'issuer-indicative', price: record.intelligence.issuerIndicativePriceUsd,
      currency: record.intelligence.market.currency ?? 'USD',
      unitDescription: 'Issuer indicative unit; economics unverified',
      retrievedAt: record.intelligence.issuerPriceRetrievedAt, displayOnly: true,
    });
    if (reference.success) references.push(reference.data);
  }
  return { observation, references };
}
