import 'server-only';
import { normalizeStockUniverse, selectTopIssuerRecords } from '@/adapters/market/stocks';
import { StockMarketRecordSchema, StockMarketPageSchema, StockMarketDetailSchema,
  selectStockMarketPage, summarizeStockMarket, type StockMarketQuery } from '@/domain/stocks';
import { projectJupiterObservation } from '@/domain/market-observations';
import { resolveDisplayTokenPrice } from '@/domain/market-price-policy';
import type { PublishedMarketSnapshot } from '@/domain/market-snapshot';
import { readCurrentMarketSnapshot } from './market-v2-reader';
import { getCachedStockContext, readOfflineStockMarketPage, marketEvidenceFor } from './stocks-market';

/** Compatibility view of the SAME immutable canonical snapshot. It never
 * launches the former legacy catalog or price workers. */
export function legacySnapshotRecords(snapshot: PublishedMarketSnapshot, now = Date.now()) {
  const rows = new Map(snapshot.prices?.rows.map(row => [row.mint, row]) ?? []);
  return snapshot.catalog.registry.entries.filter(entry => entry.catalogState !== 'delisted'
    && entry.variant.verification === 'issuer-confirmed').map(entry => {
    const variant = entry.variant, data = rows.get(variant.mint);
    const [base] = normalizeStockUniverse([{ name: variant.tokenName ?? variant.tokenSymbol, symbol: variant.tokenSymbol,
      underlying: { symbol: variant.underlying.symbol, isin: variant.underlying.isin,
        listingCountry: variant.underlying.listingCountry,
        type: variant.productClass === 'equity' ? 'Equity' : variant.productClass === 'etf' ? 'ETF' : null },
      isTradingHalted: variant.tradingHalted === true,
      deployments: [{ network: 'Solana', address: variant.mint }] }], [], variant.retrievedAt);
    const display = resolveDisplayTokenPrice({ variant, catalogState: entry.catalogState,
      conflicts: entry.conflicts.length, observation: data?.observation, now });
    const observation = projectJupiterObservation({ mint: variant.mint, priceUsd: display.priceUsd,
      priceChange24hPct: data?.enrichment?.change24h?.value.toString() ?? null,
      blockId: null, decimals: variant.decimals, retrievedAt: display.retrievedAt }, now);
    const context = getCachedStockContext(variant.mint)?.record.intelligence;
    return StockMarketRecordSchema.parse({ ...base, tokenProgram: variant.tokenProgram, decimals: variant.decimals,
      priceUsd: display.priceUsd, priceSource: display.priceUsd ? 'jupiter-price-v3' : 'none',
      priceUpdatedAt: display.retrievedAt, marketObservation: observation,
      priceChange24hPct: data?.enrichment?.change24h?.value.toString() ?? null,
      liquidityUsd: data?.enrichment?.liquidity?.value.toString() ?? variant.reportedLiquidityUsd ?? null,
      volume24hUsd: variant.reportedVolume24hUsd ?? null, tokenizedMarketCapUsd: variant.reportedTokenizedCapUsd,
      intelligence: { ...base.intelligence, ...(context ?? {}), market: {
        ...base.intelligence!.market, ...(variant.listing ? { currency: variant.listing.currency,
          period: variant.listing.period, openNow: variant.listing.openNow, nextChangeAt: variant.listing.nextChangeAt } : {}),
        tradingHalted: variant.tradingHalted },
        // Cached enrichment must not retain a comparison against a newer/different quote.
        premiumDiscount: base.intelligence!.premiumDiscount },
      sources: [...base.sources, ...(display.retrievedAt ? [{ label: 'Jupiter Price V3',
        url: 'https://developers.jup.ag/docs/price', observedAt: null, retrievedAt: display.retrievedAt }] : [])] });
  });
}

export async function readManagedLegacyPage(query: StockMarketQuery) {
  const { read } = await readCurrentMarketSnapshot();
  if (!read.snapshot) return { page: readOfflineStockMarketPage(query), retryAfterSeconds: null };
  const records = selectTopIssuerRecords(legacySnapshotRecords(read.snapshot), 300);
  const selected = selectStockMarketPage(records, query);
  const fallback = readOfflineStockMarketPage(query);
  return { page: StockMarketPageSchema.parse({ ...fallback, records: selected.records,
    status: read.degraded ? 'stale' : 'partial', summary: summarizeStockMarket(records),
    pagination: { page: selected.page, pageSize: query.pageSize, total: selected.total, totalPages: selected.totalPages },
    updatedAt: read.snapshot.prices?.completedAt ?? read.snapshot.catalog.publishedAt,
    issues: ['Compatibility view reads the shared canonical snapshot. Optional issuer/Lend/Meteora context is populated by the persistent worker.'],
    providers: { ...fallback.providers, jupiterPrice: read.snapshot.prices ? 'partial' : 'unavailable' } }), retryAfterSeconds: null };
}

export async function readManagedLegacyDetail(mint: string) {
  const { read } = await readCurrentMarketSnapshot();
  if (!read.snapshot) return null;
  const record = legacySnapshotRecords(read.snapshot).find(row => row.mint === mint);
  if (!record) return null;
  const cached = getCachedStockContext(mint);
  return StockMarketDetailSchema.parse({ status: 'stale', record,
    ...(cached?.marketEvidence ? { marketEvidence: marketEvidenceFor(record, cached.marketEvidence.meteoraPool) } : {}),
    issues: ['Shared snapshot read. Optional context retains its original source timestamps.'] });
}
