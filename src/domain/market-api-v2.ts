import { z } from 'zod';
import { decimal } from './amounts';
import { CanonicalStockAssetSchema, MarketTimestampSchema, OptionalCompanyCapSchema,
  SolanaStockVariantSchema, VariantCapSchema } from './market-types';
import { calculateVariantSolanaCap } from './market-cap-policy';
import { ResolvedCanonicalPriceSchema, VariantPriceDecisionSchema, resolveCanonicalTokenPrice,
  resolveVariantTokenPrice, resolveDisplayTokenPrice, DisplayTokenPriceSchema,
  canQueryExactIssuerPrice,
  type VariantTokenObservation } from './market-price-policy';
import type { MarketSnapshotRead } from '@/services/market-snapshot-reader';
import { MarketEnrichmentSchema } from './market-enrichment';
import { StockMarketDetailSchema, StockIntelligenceSchema } from './stocks';
import { StockRichDataSchema, ageRichData, listedSession, type StockRichData } from './stock-rich-data';

export const CanonicalMarketQuerySchema = z.object({
  view: z.enum(['tokenized', 'listed']).default('tokenized'),
  search: z.string().trim().max(64).default(''),
  type: z.enum(['all', 'equity', 'etf', 'other']).default('all'),
  verification: z.enum(['all', 'issuer-confirmed', 'other']).default('all'),
  price: z.enum(['all', 'observed', 'available', 'unavailable']).default('all'),
  market: z.enum(['all', 'open', 'closed', 'halted', 'unknown']).default('all'),
  country: z.string().regex(/^(all|[A-Z]{2})$/).default('all'),
  currency: z.string().regex(/^(all|[A-Z]{3})$/).default('all'),
  sort: z.enum(['name', 'availability', 'price', 'variants', 'reportedCap', 'listedCap', 'liquidity', 'volume', 'change', 'holders', 'fdv']).default('name'),
  watchlist: z.string().max(4500).default('').refine(value => !value || value === 'none' || (value.split(',').length <= 100 && value.split(',').every(mint => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))), 'Invalid watchlist'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type CanonicalMarketQuery = z.infer<typeof CanonicalMarketQuerySchema>;

const SelectedPriceSchema = z.object({
  mint: z.string(), usd: z.string(), unit: z.string(), source: z.literal('jupiter-price-v3'),
  observedAt: MarketTimestampSchema, lastSuccessfulRetrievalAt: MarketTimestampSchema,
}).strict();
export const CanonicalMarketRowSchema = z.object({
  id: z.string(), symbol: z.string(), name: z.string(), isin: z.string().nullable(),
  productClass: z.enum(['equity', 'etf', 'leveraged', 'inverse', 'synthetic', 'basket', 'private', 'unknown']),
  verification: z.string(), variantCount: z.number().int().positive(), variantMints: z.array(z.string()).max(2000),
  logoUrl: z.url().startsWith('https://xstocks-metadata.backed.fi/logos/tokens/').nullable(),
  price: SelectedPriceSchema.nullable(), priceUnavailableReason: z.string().nullable(),
  displayPrice: DisplayTokenPriceSchema,
  liquidMintCount: z.number().int().nonnegative(),
  reportedVolume24hUsd: z.string().nullable(), reportedVolumeMintCount: z.number().int().nonnegative(),
  reportedTokenizedCapUsd: z.string().nullable(), reportedCapMintCount: z.number().int().nonnegative(),
  reportedCapSource: z.enum(['jupiter-tokens-v2','dexscreener','mixed']).nullable(),
  reportedCapRetrievedAt: MarketTimestampSchema.nullable(),
  companyCap: OptionalCompanyCapSchema,
  marketData: MarketEnrichmentSchema.nullable().default(null),
  listedData: MarketEnrichmentSchema.nullable().default(null),
  listingCountry: z.string().nullable().default(null),
  listingExchange: z.string().nullable().default(null),
  listingCurrency: z.string().nullable().default(null),
  tokenSymbol: z.string().nullable().default(null),
  marketStatus: z.enum(['open', 'closed', 'halted', 'unknown']).default('unknown'),
  marketStatusValidUntil: MarketTimestampSchema.nullable().default(null),
  issuerContext: StockIntelligenceSchema.pick({ issuerIndicativePriceUsd: true,
    issuerPriceRetrievedAt: true, issuerPriceSourceUrl: true, supply: true, reserve: true }).nullable().default(null),
  rich: StockRichDataSchema.nullable().default(null),
}).strict();

export const MarketTickerItemSchema = CanonicalMarketRowSchema.pick({ id: true, symbol: true,
  name: true, displayPrice: true }).extend({
  change24h: MarketEnrichmentSchema.shape.change24h,
}).strict();

type CompanyRow = z.infer<typeof CanonicalMarketRowSchema>;
const companyCapField = (row: CompanyRow) => ['equity', 'private', 'unknown'].includes(row.productClass)
  ? row.listedData?.companyCap ?? null : null;

/** No FX guesses: USD, then unlabelled provider caps, then other currency groups.
 * Missing caps always follow ranked companies, even for ascending sorts. */
export function compareCompanyCaps(a: CompanyRow, b: CompanyRow, direction: 'asc' | 'desc' = 'desc') {
  const left = companyCapField(a), right = companyCapField(b);
  if (!left || !right) return Number(!left) - Number(!right) || a.id.localeCompare(b.id);
  const group = (currency: string | null) => currency === 'USD' ? '0' : currency === null ? '1' : `2${currency}`;
  return group(left.currency).localeCompare(group(right.currency))
    || (direction === 'desc' ? -1 : 1) * decimal(String(left.value)).comparedTo(right.value)
    || a.id.localeCompare(b.id);
}

export function topCompanyRows(rows: readonly CompanyRow[]) {
  const seen = new Set<string>();
  return rows.filter(row => row.displayPrice.priceUsd !== null && companyCapField(row)
    && ['equity', 'private'].includes(row.productClass)).sort(compareCompanyCaps).filter(row => {
    const key = row.isin ?? `${row.listingCountry ?? ''}:${row.symbol.toUpperCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 20);
}

export const CanonicalMarketPageSchema = z.object({
  enrichmentVersion: z.string().nullable().default(null),
  version: z.literal(2), status: z.enum(['ready', 'degraded', 'unavailable']),
  source: z.enum(['current', 'previous', 'local-previous', 'bundled', 'unavailable']),
  catalog: z.object({ id: z.string().nullable(), status: z.string(), publishedAt: MarketTimestampSchema.nullable(),
    truncated: z.boolean() }).strict(),
  providers: z.object({ xstocks: z.string(), jupiterTag: z.string(),
    xstocksRecords: z.number().int().nonnegative(), jupiterTagRecords: z.number().int().nonnegative(),
    xstocksLastSuccess: MarketTimestampSchema.nullable(), jupiterTagLastSuccess: MarketTimestampSchema.nullable(),
    jupiterPrice: z.enum(['ready', 'partial', 'stale', 'unavailable']) }).strict(),
  prices: z.object({ snapshotId: z.string().nullable(), completedAt: MarketTimestampSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(), totalBatches: z.number().int().nonnegative(),
    processedBatches: z.number().int().nonnegative(), failedBatchCount: z.number().int().nonnegative(),
    failedMintCount: z.number().int().nonnegative(),
    omittedMintCount: z.number().int().nonnegative(), incomplete: z.boolean(),
    cycleState: z.enum(['idle', 'running', 'backoff', 'complete', 'failed']),
  }).strict(),
  summary: z.object({ canonicalCount: z.number().int().nonnegative(),
    referencePriceCount: z.number().int().nonnegative().default(0),
    providerCompanyCapCount: z.number().int().nonnegative().default(0),
    inputCandidateRecordCount: z.number().int().nonnegative(), inputUniqueMintCount: z.number().int().nonnegative(),
    inputDuplicateRecordCount: z.number().int().nonnegative(), reviewedCandidateRecordCount: z.number().int().nonnegative(),
    verifiedUnderlyingCount: z.number().int().nonnegative(), issuerConfirmedUnderlyingCount: z.number().int().nonnegative(),
    exactMintCount: z.number().int().nonnegative(), issuerConfirmedMintCount: z.number().int().nonnegative(),
    equityMintCount: z.number().int().nonnegative(), etfMintCount: z.number().int().nonnegative(),
    unclassifiedMintCount: z.number().int().nonnegative(), otherClassMintCount: z.number().int().nonnegative(),
    unresolvedMintCount: z.number().int().nonnegative(), delistedMintCount: z.number().int().nonnegative(),
    pendingRemovalMintCount: z.number().int().nonnegative(), quarantinedMintCount: z.number().int().nonnegative(),
    conflictedMintCount: z.number().int().nonnegative(), haltedMintCount: z.number().int().nonnegative(),
    multiVariantUnderlyingCount: z.number().int().nonnegative(),
    priceTargetMintCount: z.number().int().nonnegative(), priceAttemptedMintCount: z.number().int().nonnegative(),
    priceReturnedMintCount: z.number().int().nonnegative(),
    displayPriceLiveMintCount: z.number().int().nonnegative(), displayPriceDelayedMintCount: z.number().int().nonnegative(),
    displayPriceStaleMintCount: z.number().int().nonnegative(), displayPriceUnavailableMintCount: z.number().int().nonnegative(),
    displayPriceUnderlyingCount: z.number().int().nonnegative(),
    eligibleVerifiedMintCount: z.number().int().nonnegative(), priceAvailableMintCount: z.number().int().nonnegative(),
    priceAvailableUnderlyingCount: z.number().int().nonnegative(), liquidMintCount: z.number().int().nonnegative(),
    reportedVolumeMintCount: z.number().int().nonnegative(), reportedVolume24hUsd: z.string().nullable(),
    companyCapAvailableUnderlyingCount: z.number().int().nonnegative(),
    companyCapUnavailableUnderlyingCount: z.number().int().nonnegative(),
    companyCapNotApplicableUnderlyingCount: z.number().int().nonnegative(),
    coveredSolanaTokenizedCap: z.object({ basis: z.literal('all-issuer-confirmed-non-delisted-mints'),
      status: z.enum(['complete', 'partial', 'unavailable']),
      valueUsd: z.string().nullable(), eligibleMintCount: z.number().int().nonnegative(),
      verifiedMintCount: z.number().int().nonnegative(), coveragePct: z.string(),
      calculatedAt: MarketTimestampSchema.nullable() }).strict(),
    reportedTokenizedCapUsd: z.string().nullable(), reportedCapMintCount: z.number().int().nonnegative(),
    reportedCapSource: z.enum(['jupiter-tokens-v2','dexscreener','mixed']).nullable(),
    reportedCapOldestRetrievedAt: MarketTimestampSchema.nullable(),
  }).strict(),
  pagination: z.object({ page: z.number().int().positive(), pageSize: z.number().int().min(1).max(50),
    total: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative() }).strict(),
  records: z.array(CanonicalMarketRowSchema).max(50),
  ticker: z.array(MarketTickerItemSchema).max(20).default([]),
  facets: z.object({ countries: z.array(z.string()).max(250),
    currencies: z.array(z.string()).max(250) }).strict().default({ countries: [], currencies: [] }),
}).strict();

export const CanonicalMarketDetailSchema = z.object({
  version: z.literal(2), asset: CanonicalStockAssetSchema,
  enrichmentVersion: z.string().nullable().default(null),
  context: StockMarketDetailSchema.nullable().default(null),
  selectedPrice: ResolvedCanonicalPriceSchema,
  variants: z.array(z.object({
    mint: z.string(), variant: SolanaStockVariantSchema,
    catalogState: z.enum(['active', 'pending-removal', 'quarantined', 'delisted']),
    conflicts: z.array(z.string()), lastAttempt: z.enum(['success', 'omitted', 'failed']).nullable(),
    retainedLastGood: z.boolean(), tokenPrice: VariantPriceDecisionSchema,
    marketData: MarketEnrichmentSchema.nullable().default(null),
    rich: StockRichDataSchema.nullable().default(null),
    displayPrice: DisplayTokenPriceSchema,
    lastObservation: z.object({ priceUsd: z.string(), unit: z.string(),
      observedAt: MarketTimestampSchema, retrievedAt: MarketTimestampSchema }).strict().nullable(),
    variantCap: VariantCapSchema, companyCap: OptionalCompanyCapSchema,
    issuerReference: z.object({ status: z.enum(['available', 'unavailable']), valueUsd: z.string().nullable(),
      retrievedAt: MarketTimestampSchema.nullable(), sourceUrl: z.url().startsWith('https://').nullable(),
      reason: z.string().nullable() }).strict(),
  }).strict()).max(2000),
  catalogId: z.string(), priceSnapshotId: z.string().nullable(),
  degraded: z.boolean(), source: z.enum(['current', 'previous', 'local-previous', 'bundled', 'unavailable']),
}).strict();

function issuerLogo(symbol: string, confirmed: boolean) {
  return confirmed && /^[A-Za-z0-9._-]{1,64}$/.test(symbol)
    ? `https://xstocks-metadata.backed.fi/logos/tokens/${encodeURIComponent(symbol)}.png` : null;
}

type Row = z.infer<typeof CanonicalMarketRowSchema>;
type Page = z.infer<typeof CanonicalMarketPageSchema>;
type Snapshot = NonNullable<MarketSnapshotRead['snapshot']>;

function companyCap(productClass: Row['productClass']): Row['companyCap'] {
  return OptionalCompanyCapSchema.parse(productClass === 'etf'
    ? { status: 'not-applicable', valueUsd: null, reason: 'etf' }
    : { status: 'unavailable', valueUsd: null, reason: 'missing-cik' });
}

export function withDexDisplay(display: z.infer<typeof DisplayTokenPriceSchema>, rich: StockRichData | null | undefined, allowed: boolean, now: number) {
  const dex=rich?.dex, age=dex?now-Date.parse(dex.retrievedAt):Infinity;
  if(display.status==='UNAVAILABLE'&&allowed&&dex?.priceUsd&&age>=0&&age<=600_000)return DisplayTokenPriceSchema.parse({
    mint:display.mint,priceUsd:String(dex.priceUsd),observedAt:dex.retrievedAt,retrievedAt:dex.retrievedAt,
    source:'dexscreener',reason:null,status:age<=45_000?'LIVE':age<=120_000?'DELAYED':'STALE',eligibleForSensitiveUse:false});
  return display;
}

/** A bounded response projection: no provider reads, no client-side full-universe payload. */
export function projectCanonicalMarket(input: {
  read: MarketSnapshotRead; query: CanonicalMarketQuery; nowMs: number;
  progress?: { state: 'running' | 'backoff' | 'complete' | 'failed' } | null;
  rich?: ReadonlyMap<string, StockRichData>; enrichmentVersion?: string;
  onFilteredRows?: (rows:Row[])=>void;
}): Page {
  const query = CanonicalMarketQuerySchema.parse(input.query);
  const snapshot = input.read.snapshot;
  const empty = !snapshot;
  const registry = snapshot?.catalog.registry;
  const active = registry?.entries.filter(entry => entry.catalogState !== 'delisted') ?? [];
  const entryByMint = new Map(active.map(entry => [entry.variant.mint, entry]));
  const rich = new Map(active.map(e => [e.variant.mint, e.conflicts.length === 0 && e.variant.verification === 'issuer-confirmed' ? ageRichData(input.rich?.get(e.variant.mint),input.nowMs) : null]));
  const tokenCap = (mint: string) => rich.get(mint)?.dex?.marketCap?.toString() ?? entryByMint.get(mint)?.variant.reportedTokenizedCapUsd ?? null;
  const capTime=(mint:string)=>rich.get(mint)?.dex?.marketCap!=null?rich.get(mint)!.dex!.retrievedAt:entryByMint.get(mint)?.variant.reportedMarketRetrievedAt;
  const capSource=(entries:typeof active):'dexscreener'|'jupiter-tokens-v2'|'mixed'|null=>{
    const sources=new Set(entries.filter(e=>tokenCap(e.variant.mint)!=null).map(e=>rich.get(e.variant.mint)?.dex?.marketCap!=null?'dexscreener':'jupiter-tokens-v2'));
    return sources.size>1?'mixed':[...sources][0] as 'dexscreener'|'jupiter-tokens-v2'|undefined??null;
  };
  const tokenVolume = (mint: string) => rich.get(mint)?.dex?.volume24h?.toString() ?? entryByMint.get(mint)?.variant.reportedVolume24hUsd ?? null;
  const priceRows = new Map(snapshot?.prices?.rows.map(row => [row.mint, row]) ?? []);
  const hasLiquidity = (entry: typeof active[number]) => {
    const observed = priceRows.get(entry.variant.mint)?.enrichment?.liquidity;
    const value = rich.get(entry.variant.mint)?.dex?.liquidity?.toString() ?? observed?.value.toString() ?? entry.variant.reportedLiquidityUsd;
    return value != null && decimal(value).gt(0);
  };
  const variantsByAsset = registry?.assets.map(asset => ({ asset,
    entries: asset.variantMints.flatMap(mint => { const entry = entryByMint.get(mint); return entry ? [entry] : []; }),
  })).filter(group => group.entries.length > 0) ?? [];
  const variantCountByMint = new Map(variantsByAsset.flatMap(({ asset }) =>
    asset.variantMints.map(mint => [mint, asset.variantMints.length] as const)));
  const displayByMint = new Map(active.map(entry => {
    const base = resolveDisplayTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
      conflicts: entry.conflicts.length, observation: priceRows.get(entry.variant.mint)?.observation,
      now: input.nowMs });
    const display=withDexDisplay(base,rich.get(entry.variant.mint),canQueryExactIssuerPrice(entry)&&entry.conflicts.length===0,input.nowMs);
    return [entry.variant.mint,display] as const;
  }));
  const rows: Array<Row & { search: string }> = variantsByAsset.map(({ asset, entries }) => {
    const prices = entries.map(entry => {
      const observation = priceRows.get(entry.variant.mint)?.observation;
      return resolveVariantTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
        conflicts: entry.conflicts.length, observations: observation ? [observation] : [],
        canonicalVariantCount: asset.variantMints.length, now: input.nowMs });
    });
    const selected = prices.filter((item): item is Extract<typeof item, { status: 'eligible' }> => item.status === 'eligible')
      .sort((a, b) => a.ageMs - b.ageMs || a.mint.localeCompare(b.mint))[0] ?? null;
    const displayed = entries.map(entry => displayByMint.get(entry.variant.mint)!)
      .sort((a, b) => (a.status === 'UNAVAILABLE' ? 1 : 0) - (b.status === 'UNAVAILABLE' ? 1 : 0)
        || (b.observedAt ?? '').localeCompare(a.observedAt ?? '') || a.mint.localeCompare(b.mint))[0];
    const first = entries[0]?.variant;
    const reported = entries.map(entry => tokenCap(entry.variant.mint))
      .filter((value): value is string => value !== null);
    const volumes = entries.map(entry => tokenVolume(entry.variant.mint))
      .filter((value): value is string => value !== null);
    const symbol = first?.underlying.symbol ?? first?.tokenSymbol ?? asset.id;
    return { id: asset.id, symbol, name: first?.tokenName ?? symbol, isin: asset.underlyingIsin,
      productClass: asset.productClass==='unknown' && rich.get(displayed.mint)?.listed?.kind !== 'unknown' ? rich.get(displayed.mint)?.listed?.kind ?? asset.productClass : asset.productClass, verification: asset.verification,
      variantCount: entries.length, variantMints: entries.map(entry => entry.variant.mint),
      logoUrl: first ? issuerLogo(first.tokenSymbol, first.verification === 'issuer-confirmed' && first.issuer === 'xstocks') : null,
      price: selected ? {
        mint: selected.mint, usd: selected.priceUsd, unit: `${selected.unit.kind}:${selected.unit.id}`,
        source: 'jupiter-price-v3' as const, observedAt: selected.providerObservedAt,
        lastSuccessfulRetrievalAt: selected.retrievedAt,
      } : null,
      priceUnavailableReason: selected ? null : prices.find(item => item.status === 'blocked')?.reason ?? 'no-token-observation',
      displayPrice: displayed,
      liquidMintCount: entries.filter(hasLiquidity).length,
      reportedVolume24hUsd: volumes.length ? volumes.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      reportedVolumeMintCount: volumes.length,
      reportedTokenizedCapUsd: reported.length ? reported.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      reportedCapMintCount: reported.length,
      reportedCapSource: capSource(entries),
      reportedCapRetrievedAt: entries.flatMap(e=>capTime(e.variant.mint)??[]).sort()[0]??null,
      companyCap: companyCap(asset.productClass),
      marketData: priceRows.get(displayed.mint)?.enrichment ?? null,
      rich: rich.get(displayed.mint) ?? null,
      listedData: entries.flatMap(entry => {
        const data = priceRows.get(entry.variant.mint)?.enrichment;
        return data?.referencePrice && entry.conflicts.length === 0 ? [data] : [];
      }).sort((a, b) => b.referencePrice!.retrievedAt.localeCompare(a.referencePrice!.retrievedAt) || a.mint.localeCompare(b.mint))[0] ?? null,
      listingCountry: first?.underlying.listingCountry ?? null,
      issuerContext: null,
      listingExchange: first?.listing?.exchange ?? null,
      listingCurrency: rich.get(displayed.mint)?.listed?.currency ?? first?.listing?.currency ?? null,
      tokenSymbol: entryByMint.get(displayed.mint)?.variant.tokenSymbol ?? first?.tokenSymbol ?? null,
      // A cached session flag is no longer authoritative after its next transition.
      marketStatus: query.view==='listed'?listedSession(rich.get(displayed.mint)?.listed,input.nowMs).status:first?.tradingHalted === true ? 'halted' as const
        : first?.listing?.nextChangeAt && Date.parse(first.listing.nextChangeAt) > input.nowMs
          ? first.listing.openNow === true ? 'open' as const : first.listing.openNow === false ? 'closed' as const : 'unknown' as const
          : 'unknown' as const,
      marketStatusValidUntil: query.view==='listed'?listedSession(rich.get(displayed.mint)?.listed,input.nowMs).until:first?.listing?.nextChangeAt ?? null,
      search: [asset.id, ...entries.flatMap(entry => [entry.variant.mint, entry.variant.tokenName ?? '', entry.variant.tokenSymbol,
        entry.variant.underlying.symbol ?? '', entry.variant.underlying.isin ?? ''])].join(' ').toLowerCase(),
    };
  });
  const verifiedMints = active.filter(entry => entry.catalogState === 'active'
    && entry.variant.verification === 'issuer-confirmed' && entry.variant.eligibility === 'eligible'
    && entry.conflicts.length === 0);
  const issuerConfirmedMints = active.filter(entry => entry.variant.verification === 'issuer-confirmed');
  const priceAvailableMintCount = verifiedMints.filter(entry => {
    const observation: VariantTokenObservation | undefined = priceRows.get(entry.variant.mint)?.observation ?? undefined;
    if (!observation) return false;
    return resolveVariantTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
      conflicts: 0, observations: [observation], canonicalVariantCount: variantCountByMint.get(entry.variant.mint) ?? 1,
      now: input.nowMs }).status === 'eligible';
  }).length;
  const reportedMintRows = active.map(entry => tokenCap(entry.variant.mint))
    .filter((value): value is string => value !== null);
  const volumeMintRows = active.map(entry => tokenVolume(entry.variant.mint))
    .filter((value): value is string => value !== null);
  const covered = snapshot?.capCoverage?.summary;
  const needle = query.search.toLowerCase();
  const displayedValue = (row: Row) => query.view === 'listed'
    ? row.rich?.listed?.price?.toString() ?? row.listedData?.referencePrice?.value.toString() ?? null : row.displayPrice.priceUsd;
  const watch = new Set(query.watchlist.split(','));
  const filtered = rows.filter(row => (!needle || row.search.includes(needle))
    && (!query.watchlist || row.variantMints.some(mint=>watch.has(mint)))
    && (query.market === 'all' || row.marketStatus === query.market)
    && (query.country === 'all' || row.listingCountry === query.country)
    && (query.currency === 'all' || row.listingCurrency === query.currency)
    && (query.type === 'all' || (query.type === 'other' ? !['equity', 'etf'].includes(row.productClass) : row.productClass === query.type))
    && (query.verification === 'all' || (query.verification === 'issuer-confirmed'
      ? row.verification === 'issuer-confirmed' : row.verification !== 'issuer-confirmed'))
    && (query.price === 'all' || (query.price === 'available' ? (query.view === 'listed' ? displayedValue(row) !== null : row.price !== null)
      : query.price === 'observed' ? displayedValue(row) !== null : displayedValue(row) === null)));
  const compareNumber = (left: string | null, right: string | null) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    const result = decimal(left).comparedTo(right);
    return query.direction === 'asc' ? result : -result;
  };
  filtered.sort((a, b) => {
    const metric = (row:Row) => query.sort==='liquidity' ? row.rich?.dex?.liquidity ?? row.marketData?.liquidity?.value
      : query.sort==='volume' ? (query.view==='listed'?row.rich?.listed?.volume:row.reportedVolume24hUsd)
      : query.sort==='change' ? (query.view==='listed'?row.rich?.listed?.change:row.rich?.dex?.change24h ?? row.marketData?.change24h?.value)
      : query.sort==='holders'?row.rich?.holders?.count:row.rich?.dex?.fdv;
    const compare = ['liquidity','volume','change','holders','fdv'].includes(query.sort) ? compareNumber(metric(a)?.toString()??null,metric(b)?.toString()??null)
      : query.sort === 'name' ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : query.sort === 'availability'
        ? (displayedValue(a) === null ? 1 : 0) - (displayedValue(b) === null ? 1 : 0)
          || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : query.sort === 'listedCap'
        ? compareCompanyCaps(a, b, query.direction)
      : query.sort === 'variants' ? a.variantCount - b.variantCount
        : query.view === 'listed' && query.sort === 'price'
          // Different currencies must not be ranked as comparable dollar values.
          ? (a.rich?.listed?.currency ?? a.listedData?.referencePrice?.currency ?? '~').localeCompare(b.rich?.listed?.currency ?? b.listedData?.referencePrice?.currency ?? '~')
            || compareNumber(displayedValue(a), displayedValue(b))
          : compareNumber(query.sort === 'price' ? displayedValue(a) : a.reportedTokenizedCapUsd,
            query.sort === 'price' ? displayedValue(b) : b.reportedTokenizedCapUsd);
    return (query.sort === 'name' || query.sort === 'availability' || query.sort === 'variants') && query.direction === 'desc' ? -compare || a.id.localeCompare(b.id)
      : compare || a.id.localeCompare(b.id);
  });
  const totalPages = Math.ceil(filtered.length / query.pageSize);
  input.onFilteredRows?.(filtered.map(({search,...row})=>{void search;return row;}));
  const page = totalPages ? Math.min(query.page, totalPages) : 1;
  const records = filtered.slice((page - 1) * query.pageSize, page * query.pageSize)
    .map(({ search, ...row }) => { void search; return row; });
  const progressState = input.progress?.state ?? 'idle';
  return CanonicalMarketPageSchema.parse({ version: 2,
    enrichmentVersion:input.enrichmentVersion??null,
    status: empty ? 'unavailable' : input.read.degraded || (snapshot?.prices?.failedCount ?? 0) > 0 ? 'degraded' : 'ready', source: input.read.source,
    catalog: { id: snapshot?.catalog.id ?? null, status: registry?.status ?? 'unavailable',
      publishedAt: snapshot?.catalog.publishedAt ?? null, truncated: registry?.truncation.truncated ?? false },
    providers: {
      xstocks: registry?.sourceStatuses.find(source => source.provider === 'xstocks')?.status ?? 'unavailable',
      jupiterTag: registry?.sourceStatuses.find(source => source.provider === 'jupiter-stocks-tag')?.status ?? 'unavailable',
      xstocksRecords: registry?.sourceStatuses.find(source => source.provider === 'xstocks')?.recordCount ?? 0,
      jupiterTagRecords: registry?.sourceStatuses.find(source => source.provider === 'jupiter-stocks-tag')?.recordCount ?? 0,
      xstocksLastSuccess: registry?.sourceStatuses.find(source => source.provider === 'xstocks')?.lastSuccess ?? null,
      jupiterTagLastSuccess: registry?.sourceStatuses.find(source => source.provider === 'jupiter-stocks-tag')?.lastSuccess ?? null,
      jupiterPrice: !snapshot?.prices ? 'unavailable'
        : input.nowMs - Date.parse(snapshot.prices.completedAt) > 120_000 ? 'stale'
          : snapshot.prices.successfulCount === 0
            && snapshot.prices.rows.every(row => row.observation === null) ? 'unavailable'
          : snapshot.prices.failedBatchCount > 0 || snapshot.prices.missingCount > 0 ? 'partial' : 'ready',
    },
    prices: { snapshotId: snapshot?.prices?.id ?? null, completedAt: snapshot?.prices?.completedAt ?? null,
      durationMs: snapshot?.prices?.durationMs ?? null, totalBatches: snapshot?.prices?.totalBatches ?? 0,
      processedBatches: snapshot?.prices?.processedBatches ?? 0, failedBatchCount: snapshot?.prices?.failedBatchCount ?? 0,
      failedMintCount: snapshot?.prices?.failedCount ?? 0,
      omittedMintCount: snapshot?.prices?.missingCount ?? 0,
      incomplete: snapshot?.prices === null || (snapshot?.prices?.failedCount ?? 0) > 0,
      cycleState: progressState },
    summary: { canonicalCount: rows.length,
      referencePriceCount: rows.filter(row => row.rich?.listed?.price!=null||row.listedData?.referencePrice).length,
      providerCompanyCapCount: rows.filter(row => row.productClass !== 'etf' && row.listedData?.companyCap).length,
      inputCandidateRecordCount: registry?.inputCoverage.candidateRecords ?? 0,
      inputUniqueMintCount: registry?.inputCoverage.uniqueCandidateMints ?? 0,
      inputDuplicateRecordCount: registry?.inputCoverage.duplicateCandidateRecords ?? 0,
      reviewedCandidateRecordCount: registry?.inputCoverage.reviewedCandidateRecords ?? 0,
      issuerConfirmedUnderlyingCount: variantsByAsset.filter(({ asset }) => asset.verification === 'issuer-confirmed').length,
      verifiedUnderlyingCount: variantsByAsset.filter(({ asset, entries }) =>
        asset.verification === 'issuer-confirmed' && ['equity', 'etf'].includes(asset.productClass)
        && entries.some(entry => entry.variant.eligibility === 'eligible' && entry.catalogState === 'active')).length,
      exactMintCount: active.length,
      issuerConfirmedMintCount: issuerConfirmedMints.length,
      equityMintCount: active.filter(entry => entry.variant.productClass === 'equity').length,
      etfMintCount: active.filter(entry => entry.variant.productClass === 'etf').length,
      unclassifiedMintCount: active.filter(entry => entry.variant.productClass === 'unknown').length,
      otherClassMintCount: active.filter(entry => !['equity', 'etf', 'unknown'].includes(entry.variant.productClass)).length,
      unresolvedMintCount: active.filter(entry => entry.variant.eligibility === 'unresolved').length,
      delistedMintCount: registry?.entries.filter(entry => entry.catalogState === 'delisted').length ?? 0,
      pendingRemovalMintCount: active.filter(entry => entry.catalogState === 'pending-removal').length,
      quarantinedMintCount: active.filter(entry => entry.catalogState === 'quarantined').length,
      conflictedMintCount: active.filter(entry => entry.conflicts.length > 0).length,
      haltedMintCount: active.filter(entry => entry.variant.tradingHalted === true).length,
      multiVariantUnderlyingCount: rows.filter(row => row.variantCount > 1).length,
      priceTargetMintCount: active.filter(canQueryExactIssuerPrice).length,
      priceAttemptedMintCount: snapshot?.prices?.rows.length ?? 0,
      priceReturnedMintCount: snapshot?.prices?.successfulCount ?? 0,
      displayPriceLiveMintCount: [...displayByMint.values()].filter(value => value.status === 'LIVE').length,
      displayPriceDelayedMintCount: [...displayByMint.values()].filter(value => value.status === 'DELAYED').length,
      displayPriceStaleMintCount: [...displayByMint.values()].filter(value => value.status === 'STALE').length,
      displayPriceUnavailableMintCount: [...displayByMint.values()].filter(value => value.status === 'UNAVAILABLE').length,
      displayPriceUnderlyingCount: rows.filter(row => row.displayPrice.status !== 'UNAVAILABLE').length,
      eligibleVerifiedMintCount: verifiedMints.length,
      priceAvailableMintCount, priceAvailableUnderlyingCount: rows.filter(row => row.price !== null).length,
      liquidMintCount: active.filter(hasLiquidity).length,
      reportedVolumeMintCount: volumeMintRows.length,
      reportedVolume24hUsd: volumeMintRows.length
        ? volumeMintRows.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      companyCapAvailableUnderlyingCount: rows.filter(row => row.companyCap.status === 'estimated').length,
      companyCapUnavailableUnderlyingCount: rows.filter(row => row.companyCap.status === 'unavailable').length,
      companyCapNotApplicableUnderlyingCount: rows.filter(row => row.companyCap.status === 'not-applicable').length,
      coveredSolanaTokenizedCap: { basis: 'all-issuer-confirmed-non-delisted-mints',
        status: covered?.status ?? 'unavailable', valueUsd: covered?.valueUsd ?? null,
        eligibleMintCount: covered?.eligibleMintCount ?? 0, verifiedMintCount: covered?.verifiedMintCount ?? issuerConfirmedMints.length,
        coveragePct: covered?.coveragePct ?? '0', calculatedAt: snapshot?.capCoverage?.calculatedAt ?? null },
      reportedTokenizedCapUsd: reportedMintRows.length
        ? reportedMintRows.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      reportedCapMintCount: reportedMintRows.length,
      reportedCapSource: capSource(active),
      reportedCapOldestRetrievedAt: active.flatMap(e=>capTime(e.variant.mint)??[]).sort()[0]??null },
    pagination: { page, pageSize: query.pageSize, total: filtered.length, totalPages }, records,
    facets: { countries: [...new Set(rows.flatMap(row => row.listingCountry ? [row.listingCountry] : []))].sort(),
      currencies: [...new Set(rows.flatMap(row => row.listingCurrency ? [row.listingCurrency] : []))].sort() },
    // Top companies are independent of table filters and use the same token quotes.
    ticker: topCompanyRows(rows).map(row => {
      const dex=row.rich?.dex;
      const change = dex?.change24h!=null ? {value:dex.change24h,currency:null,retrievedAt:dex.retrievedAt} : row.marketData?.change24h;
      const age = change ? input.nowMs - Date.parse(change.observedAt ?? change.retrievedAt) : Infinity;
      return { id: row.id, symbol: row.tokenSymbol ?? row.symbol, name: row.name,
        displayPrice: row.displayPrice, change24h: age >= -5000 && age <= 600_000 ? change ?? null : null };
    }),
  });
}

export function projectCanonicalDetail(read: MarketSnapshotRead, assetId: string, nowMs: number) {
  const snapshot: Snapshot | null = read.snapshot;
  const asset = snapshot?.catalog.registry.assets.find(item => item.id === assetId);
  if (!snapshot || !asset) return null;
  const entries = new Map(snapshot.catalog.registry.entries.map(entry => [entry.variant.mint, entry]));
  const prices = new Map(snapshot.prices?.rows.map(row => [row.mint, row]) ?? []);
  const observations = asset.variantMints.flatMap(mint => {
    const observation = prices.get(mint)?.observation;
    return observation ? [observation] : [];
  });
  return CanonicalMarketDetailSchema.parse({ version: 2, asset,
    selectedPrice: resolveCanonicalTokenPrice({ registry: snapshot.catalog.registry,
      assetId, observations, now: nowMs }),
    variants: asset.variantMints.map(mint => {
    const entry = entries.get(mint)!;
    const priceRow = prices.get(mint);
    return { mint, variant: entry.variant, catalogState: entry.catalogState,
      conflicts: entry.conflicts.map(conflict => conflict.reason),
      lastAttempt: priceRow?.attempt ?? null, retainedLastGood: priceRow?.retainedLastGood ?? false,
      marketData: entry.conflicts.length === 0 ? priceRow?.enrichment ?? null : null,
      tokenPrice: resolveVariantTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
        conflicts: entry.conflicts.length, observations: priceRow?.observation ? [priceRow.observation] : [],
        canonicalVariantCount: asset.variantMints.length, now: nowMs }),
      displayPrice: resolveDisplayTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
        conflicts: entry.conflicts.length, observation: priceRow?.observation, now: nowMs }),
      lastObservation: priceRow?.observation?.price && priceRow.observation.currency === 'USD'
        && priceRow.observation.retrievedAt && (priceRow.observation.providerObservedAt ?? priceRow.observation.retrievedAt)
        ? { priceUsd: priceRow.observation.price,
          unit: `${priceRow.observation.unit.kind}:${priceRow.observation.unit.id ?? 'unknown'}`,
          observedAt: priceRow.observation.providerObservedAt ?? priceRow.observation.retrievedAt,
          retrievedAt: priceRow.observation.retrievedAt } : null,
      variantCap: calculateVariantSolanaCap({ entry, canonicalVariantCount: asset.variantMints.length,
        observations: priceRow?.observation ? [priceRow.observation] : [], supplies: [], now: nowMs }),
      issuerReference: { status: 'unavailable', valueUsd: null, retrievedAt: null,
        sourceUrl: entry.variant.evidence.find(evidence => evidence.kind === 'issuer-declaration')?.sourceUrl ?? null,
        reason: 'No qualified same-unit issuer quote is cached in the canonical snapshot.' },
      companyCap: companyCap(asset.productClass) };
  }), catalogId: snapshot.catalog.id, priceSnapshotId: snapshot.prices?.id ?? null,
    degraded: read.degraded, source: read.source });
}
