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

export const CanonicalMarketQuerySchema = z.object({
  search: z.string().trim().max(64).default(''),
  type: z.enum(['all', 'equity', 'etf', 'other']).default('all'),
  verification: z.enum(['all', 'issuer-confirmed', 'other']).default('all'),
  price: z.enum(['all', 'observed', 'available', 'unavailable']).default('all'),
  sort: z.enum(['name', 'availability', 'price', 'variants', 'reportedCap']).default('name'),
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
  reportedCapSource: z.literal('jupiter-tokens-v2').nullable(),
  reportedCapRetrievedAt: MarketTimestampSchema.nullable(),
  companyCap: OptionalCompanyCapSchema,
}).strict();

export const CanonicalMarketPageSchema = z.object({
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
    reportedCapSource: z.literal('jupiter-tokens-v2').nullable(),
    reportedCapOldestRetrievedAt: MarketTimestampSchema.nullable(),
  }).strict(),
  pagination: z.object({ page: z.number().int().positive(), pageSize: z.number().int().min(1).max(50),
    total: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative() }).strict(),
  records: z.array(CanonicalMarketRowSchema).max(50),
}).strict();

export const CanonicalMarketDetailSchema = z.object({
  version: z.literal(2), asset: CanonicalStockAssetSchema,
  selectedPrice: ResolvedCanonicalPriceSchema,
  variants: z.array(z.object({
    mint: z.string(), variant: SolanaStockVariantSchema,
    catalogState: z.enum(['active', 'pending-removal', 'quarantined', 'delisted']),
    conflicts: z.array(z.string()), lastAttempt: z.enum(['success', 'omitted', 'failed']).nullable(),
    retainedLastGood: z.boolean(), tokenPrice: VariantPriceDecisionSchema,
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

/** A bounded response projection: no provider reads, no client-side full-universe payload. */
export function projectCanonicalMarket(input: {
  read: MarketSnapshotRead; query: CanonicalMarketQuery; nowMs: number;
  progress?: { state: 'running' | 'backoff' | 'complete' | 'failed' } | null;
}): Page {
  const query = CanonicalMarketQuerySchema.parse(input.query);
  const snapshot = input.read.snapshot;
  const empty = !snapshot;
  const registry = snapshot?.catalog.registry;
  const active = registry?.entries.filter(entry => entry.catalogState !== 'delisted') ?? [];
  const entryByMint = new Map(active.map(entry => [entry.variant.mint, entry]));
  const priceRows = new Map(snapshot?.prices?.rows.map(row => [row.mint, row]) ?? []);
  const variantsByAsset = registry?.assets.map(asset => ({ asset,
    entries: asset.variantMints.flatMap(mint => { const entry = entryByMint.get(mint); return entry ? [entry] : []; }),
  })).filter(group => group.entries.length > 0) ?? [];
  const variantCountByMint = new Map(variantsByAsset.flatMap(({ asset }) =>
    asset.variantMints.map(mint => [mint, asset.variantMints.length] as const)));
  const displayByMint = new Map(active.map(entry => [entry.variant.mint,
    resolveDisplayTokenPrice({ variant: entry.variant, catalogState: entry.catalogState,
      conflicts: entry.conflicts.length, observation: priceRows.get(entry.variant.mint)?.observation,
      now: input.nowMs })] as const));
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
    const reported = entries.map(entry => entry.variant.reportedTokenizedCapUsd)
      .filter((value): value is string => value !== null);
    const volumes = entries.map(entry => entry.variant.reportedVolume24hUsd ?? null)
      .filter((value): value is string => value !== null);
    const symbol = first?.underlying.symbol ?? first?.tokenSymbol ?? asset.id;
    return { id: asset.id, symbol, name: first?.tokenName ?? symbol, isin: asset.underlyingIsin,
      productClass: asset.productClass, verification: asset.verification,
      variantCount: entries.length, variantMints: entries.map(entry => entry.variant.mint),
      logoUrl: first ? issuerLogo(first.tokenSymbol, first.verification === 'issuer-confirmed' && first.issuer === 'xstocks') : null,
      price: selected ? {
        mint: selected.mint, usd: selected.priceUsd, unit: `${selected.unit.kind}:${selected.unit.id}`,
        source: 'jupiter-price-v3' as const, observedAt: selected.providerObservedAt,
        lastSuccessfulRetrievalAt: selected.retrievedAt,
      } : null,
      priceUnavailableReason: selected ? null : prices.find(item => item.status === 'blocked')?.reason ?? 'no-token-observation',
      displayPrice: displayed,
      liquidMintCount: entries.filter(entry => entry.variant.reportedLiquidityUsd !== null
        && entry.variant.reportedLiquidityUsd !== undefined
        && decimal(entry.variant.reportedLiquidityUsd).gt(0)).length,
      reportedVolume24hUsd: volumes.length ? volumes.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      reportedVolumeMintCount: volumes.length,
      reportedTokenizedCapUsd: reported.length ? reported.reduce((sum, value) => sum.plus(value), decimal('0')).toFixed() : null,
      reportedCapMintCount: reported.length,
      reportedCapSource: reported.length ? 'jupiter-tokens-v2' as const : null,
      reportedCapRetrievedAt: entries.filter(entry => entry.variant.reportedTokenizedCapUsd !== null)
        .flatMap(entry => entry.variant.reportedMarketRetrievedAt ? [entry.variant.reportedMarketRetrievedAt] : [])
        .sort()[0] ?? null,
      companyCap: companyCap(asset.productClass),
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
  const reportedMintRows = active.map(entry => entry.variant.reportedTokenizedCapUsd)
    .filter((value): value is string => value !== null);
  const volumeMintRows = active.map(entry => entry.variant.reportedVolume24hUsd ?? null)
    .filter((value): value is string => value !== null);
  const covered = snapshot?.capCoverage?.summary;
  const needle = query.search.toLowerCase();
  const filtered = rows.filter(row => (!needle || row.search.includes(needle))
    && (query.type === 'all' || (query.type === 'other' ? !['equity', 'etf'].includes(row.productClass) : row.productClass === query.type))
    && (query.verification === 'all' || (query.verification === 'issuer-confirmed'
      ? row.verification === 'issuer-confirmed' : row.verification !== 'issuer-confirmed'))
    && (query.price === 'all' || (query.price === 'available' ? row.price !== null
      : query.price === 'observed' ? row.displayPrice.status !== 'UNAVAILABLE'
        : row.displayPrice.status === 'UNAVAILABLE')));
  const compareNumber = (left: string | null, right: string | null) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    const result = decimal(left).comparedTo(right);
    return query.direction === 'asc' ? result : -result;
  };
  filtered.sort((a, b) => {
    const compare = query.sort === 'name' ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : query.sort === 'availability'
        ? (a.displayPrice.status === 'UNAVAILABLE' ? 1 : 0) - (b.displayPrice.status === 'UNAVAILABLE' ? 1 : 0)
          || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
      : query.sort === 'variants' ? a.variantCount - b.variantCount
        : compareNumber(query.sort === 'price' ? a.displayPrice.priceUsd : a.reportedTokenizedCapUsd,
          query.sort === 'price' ? b.displayPrice.priceUsd : b.reportedTokenizedCapUsd);
    return (query.sort === 'name' || query.sort === 'availability' || query.sort === 'variants') && query.direction === 'desc' ? -compare || a.id.localeCompare(b.id)
      : compare || a.id.localeCompare(b.id);
  });
  const totalPages = Math.ceil(filtered.length / query.pageSize);
  const page = totalPages ? Math.min(query.page, totalPages) : 1;
  const records = filtered.slice((page - 1) * query.pageSize, page * query.pageSize)
    .map(({ search, ...row }) => { void search; return row; });
  const progressState = input.progress?.state ?? 'idle';
  return CanonicalMarketPageSchema.parse({ version: 2,
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
      liquidMintCount: active.filter(entry => entry.variant.reportedLiquidityUsd !== null
        && entry.variant.reportedLiquidityUsd !== undefined
        && decimal(entry.variant.reportedLiquidityUsd).gt(0)).length,
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
      reportedCapSource: reportedMintRows.length ? 'jupiter-tokens-v2' : null,
      reportedCapOldestRetrievedAt: active.filter(entry => entry.variant.reportedTokenizedCapUsd !== null)
        .flatMap(entry => entry.variant.reportedMarketRetrievedAt ? [entry.variant.reportedMarketRetrievedAt] : [])
        .sort()[0] ?? null },
    pagination: { page, pageSize: query.pageSize, total: filtered.length, totalPages }, records,
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
