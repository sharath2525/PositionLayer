import { z } from 'zod';
import { decimal } from './amounts';
import { ProviderCandidateSchema, ProviderReadResultSchema, type ProviderCandidate, type ProviderReadResult } from './market-provider';
import {
  CanonicalStockAssetSchema, MarketIdentityConflictSchema, MarketMintSchema,
  MarketTimestampSchema, SolanaStockVariantSchema, type MarketIdentityConflict,
  type SolanaStockVariant,
} from './market-types';

// A defensive ceiling, not a product selection limit. Existing identities take
// precedence when a corrupt aggregate input exceeds it.
export const REGISTRY_INPUT_CEILING = 20_000;
const SourceSchema = z.enum(['previous', 'reviewed-snapshot', 'xstocks', 'jupiter-stocks-tag']);
const CatalogStateSchema = z.enum(['active', 'pending-removal', 'delisted', 'quarantined']);
const RegistryEntrySchema = z.object({
  variant: SolanaStockVariantSchema,
  catalogState: CatalogStateSchema,
  missingIssuerRefreshes: z.number().int().nonnegative(),
  sources: z.array(SourceSchema).min(1).max(4),
  conflicts: z.array(MarketIdentityConflictSchema).max(20),
}).strict();
const QuarantinedCandidateSchema = z.object({
  source: SourceSchema, candidate: ProviderCandidateSchema,
  conflict: MarketIdentityConflictSchema,
}).strict();
export const UniverseRegistrySchema = z.object({
  builtAt: MarketTimestampSchema,
  status: z.enum(['complete', 'degraded', 'reviewed-fallback']),
  entries: z.array(RegistryEntrySchema).max(REGISTRY_INPUT_CEILING),
  assets: z.array(CanonicalStockAssetSchema).max(REGISTRY_INPUT_CEILING),
  quarantine: z.array(QuarantinedCandidateSchema).max(REGISTRY_INPUT_CEILING),
  sourceStatuses: z.array(z.object({
    provider: ProviderReadResultSchema.shape.provider,
    status: ProviderReadResultSchema.shape.status,
    recordCount: z.number().int().nonnegative(),
    lastSuccess: MarketTimestampSchema.nullable(),
  }).strict()).max(2),
  lastProcessedIssuerSuccessAt: MarketTimestampSchema.nullable(),
  issuerEmpty: z.boolean(),
  reviewedOnlyCount: z.number().int().nonnegative(),
  inputCoverage: z.object({ candidateRecords: z.number().int().nonnegative(),
    uniqueCandidateMints: z.number().int().nonnegative(), duplicateCandidateRecords: z.number().int().nonnegative(),
    reviewedCandidateRecords: z.number().int().nonnegative() }).strict(),
  shrink: z.object({ missing: z.number().int().nonnegative(), priorIssuerMints: z.number().int().nonnegative(),
    quarantined: z.boolean() }).strict(),
  truncation: z.object({ truncated: z.boolean(), discovered: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(), sources: z.array(SourceSchema).max(4) }).strict(),
}).strict().superRefine((registry, context) => {
  const mints = registry.entries.map(entry => entry.variant.mint);
  if (new Set(mints).size !== mints.length) context.addIssue({ code: 'custom', message: 'Registry entries must have unique exact mints.' });
  const active = new Set(registry.entries.filter(entry => entry.catalogState !== 'delisted').map(entry => entry.variant.mint));
  const assetMints = registry.assets.flatMap(asset => asset.variantMints);
  if (new Set(assetMints).size !== assetMints.length || assetMints.some(mint => !active.has(mint))
      || assetMints.length !== active.size) {
    context.addIssue({ code: 'custom', message: 'Each non-delisted exact mint may occur in one canonical asset only.' });
  }
});

export type UniverseRegistry = z.infer<typeof UniverseRegistrySchema>;
type Entry = UniverseRegistry['entries'][number];
type Source = z.infer<typeof SourceSchema>;
type Incoming = { source: Source; candidate: ProviderCandidate };

/** Deterministic, previous-first defensive selection; no normal-market top-N ranking. */
export function selectRegistryInputs(previousCount: number, incoming: Incoming[], ceiling = REGISTRY_INPUT_CEILING) {
  const ordered = [...incoming].sort((a, b) =>
    (a.source === 'reviewed-snapshot' ? 0 : a.source === 'xstocks' ? 1 : 2)
      - (b.source === 'reviewed-snapshot' ? 0 : b.source === 'xstocks' ? 1 : 2)
    || a.candidate.variant.mint.localeCompare(b.candidate.variant.mint));
  const allowed = ordered.slice(0, Math.max(0, ceiling - previousCount));
  const omitted = ordered.slice(allowed.length);
  return { allowed, truncation: { truncated: omitted.length > 0,
    discovered: previousCount + ordered.length, retained: previousCount + allowed.length,
    sources: [...new Set(omitted.map(row => row.source))] as Source[] } };
}

function conflict(reason: MarketIdentityConflict['reason'], mints: string[], at: string): MarketIdentityConflict {
  return MarketIdentityConflictSchema.parse({
    reason, affectedMints: [...new Set(mints)].sort().slice(0, 20),
    explanation: `Identity review required: ${reason}.`, detectedAt: at,
  });
}
function addConflict(entry: Entry, item: MarketIdentityConflict) {
  if (!entry.conflicts.some(existing => existing.reason === item.reason &&
      existing.affectedMints.join() === item.affectedMints.join())) entry.conflicts.push(item);
  entry.conflicts = entry.conflicts.slice(0, 20);
  entry.catalogState = 'quarantined';
}
function sameMintConflict(left: SolanaStockVariant, right: SolanaStockVariant): MarketIdentityConflict['reason'] | null {
  // A discovery index may disagree with an issuer, but cannot create an
  // issuer-identity conflict or prevent the exact issuer mint from being kept.
  if (left.verification !== 'issuer-confirmed' || right.verification !== 'issuer-confirmed') return null;
  if (left.issuer !== 'unknown' && right.issuer !== 'unknown' && left.issuer !== right.issuer) return 'duplicate-mint';
  if (left.underlying.isin && right.underlying.isin && left.underlying.isin !== right.underlying.isin) return 'isin-mismatch';
  if (left.productClass !== 'unknown' && right.productClass !== 'unknown' && left.productClass !== right.productClass) return 'product-class-mismatch';
  if (left.underlying.securityClass && right.underlying.securityClass &&
      left.underlying.securityClass !== right.underlying.securityClass) return 'security-class-mismatch';
  if (left.economicUnit.kind !== 'unknown' && right.economicUnit.kind !== 'unknown' &&
      (left.economicUnit.kind !== right.economicUnit.kind || left.economicUnit.unitId !== right.economicUnit.unitId)) return 'economic-unit-mismatch';
  if (left.multiplier.status === 'current' && right.multiplier.status === 'current' &&
      left.multiplier.current !== right.multiplier.current) return 'multiplier-mismatch';
  if (left.tokenProgram && right.tokenProgram && left.tokenProgram !== right.tokenProgram) return 'duplicate-mint';
  if (left.decimals !== null && right.decimals !== null && left.decimals !== right.decimals) return 'duplicate-mint';
  return null;
}
function uniqueEvidence(left: SolanaStockVariant['evidence'], right: SolanaStockVariant['evidence']) {
  const seen = new Set<string>();
  return [...right, ...left].filter(item => {
    const key = `${item.kind}:${item.provider}:${item.exactMint ?? ''}:${item.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 12);
}
function issuerProofMatches(candidate: ProviderCandidate, source: Source) {
  const variant = candidate.variant;
  if (source === 'jupiter-stocks-tag') return variant.verification === 'indexed-only' && variant.issuer === 'unknown'
    && variant.evidence.every(item => item.kind === 'discovery-index' && item.provider === 'jupiter'
      && item.exactMint === variant.mint);
  if (source === 'xstocks' || source === 'reviewed-snapshot') return variant.issuer === 'xstocks'
    && variant.verification === 'issuer-confirmed'
    && variant.evidence.some(item => item.kind === 'issuer-declaration' && item.provider === 'xstocks'
      && item.exactMint === variant.mint)
    && variant.evidence.every(item => item.kind !== 'issuer-declaration'
      || (item.provider === 'xstocks' && item.exactMint === variant.mint));
  return true;
}

function buildAssets(entries: Entry[], at: string) {
  const active = entries.filter(entry => entry.catalogState !== 'delisted');
  const byIsin = new Map<string, Entry[]>();
  for (const entry of active) {
    const variant = entry.variant;
    if (variant.verification !== 'issuer-confirmed' || variant.eligibility !== 'eligible'
        || !variant.underlying.isin) continue;
    const group = byIsin.get(variant.underlying.isin) ?? [];
    group.push(entry); byIsin.set(variant.underlying.isin, group);
  }
  const groupable = new Map<string, Entry[]>();
  for (const [isin, group] of byIsin) {
    if (group.length < 2) continue;
    const products = new Set(group.map(entry => entry.variant.productClass));
    const classes = new Set(group.map(entry => entry.variant.underlying.securityClass ?? ''));
    const units = new Set(group.map(entry => entry.variant.economicUnit.unitId ?? ''));
    const multipliers = new Set(group.map(entry => entry.variant.multiplier.current ?? ''));
    const pendingCorporateAction = group.some(entry => entry.variant.multiplier.status === 'pending');
    const unresolved = group.some(entry => entry.catalogState === 'quarantined'
      || entry.variant.economicUnit.kind !== 'display-share' || !entry.variant.economicUnit.unitId
      || entry.variant.multiplier.status !== 'current');
    const reason = pendingCorporateAction ? 'corporate-action-unresolved'
      : products.size > 1 ? 'product-class-mismatch'
      : classes.size > 1 ? 'security-class-mismatch'
        : units.size > 1 ? 'economic-unit-mismatch'
          : multipliers.size > 1 ? 'multiplier-mismatch' : null;
    if (reason) {
      const review = conflict(reason, group.map(entry => entry.variant.mint), at);
      for (const entry of group) addConflict(entry, review);
    }
    if (!reason && !unresolved && group.length <= 2000) groupable.set(isin, group);
  }
  const assigned = new Set<string>();
  const assets: UniverseRegistry['assets'] = [];
  for (const [isin, group] of groupable) {
    const mints = group.map(entry => entry.variant.mint).sort();
    mints.forEach(mint => assigned.add(mint));
    assets.push(CanonicalStockAssetSchema.parse({
      id: `isin:${isin}:${group[0].variant.productClass}`, candidateGroupingKey: `isin:${isin}:${group[0].variant.productClass}`,
      productClass: group[0].variant.productClass, underlyingIsin: isin,
      securityClass: group[0].variant.underlying.securityClass, verification: 'issuer-confirmed',
      variantMints: mints, conflicts: [], retrievedAt: at,
    }));
  }
  for (const entry of active) {
    const variant = entry.variant;
    if (assigned.has(variant.mint)) continue;
    assets.push(CanonicalStockAssetSchema.parse({
      id: `solana:${variant.mint}`, candidateGroupingKey: null,
      productClass: variant.productClass, underlyingIsin: variant.underlying.isin,
      securityClass: variant.underlying.securityClass,
      verification: entry.conflicts.length ? 'conflicted' : variant.verification,
      variantMints: [variant.mint], conflicts: entry.conflicts, retrievedAt: at,
    }));
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id));
}

/** Pure Phase 3 registry. It cannot fetch, select prices, mutate the worker, or change public routes. */
export function buildUniverseRegistry(input: {
  reads: ProviderReadResult[];
  reviewed: ProviderCandidate[];
  previous?: UniverseRegistry | null;
  now?: string;
}): UniverseRegistry {
  const at = MarketTimestampSchema.parse(input.now ?? new Date().toISOString());
  const reads = input.reads.map(read => ProviderReadResultSchema.parse(read));
  if (new Set(reads.map(read => read.provider)).size !== reads.length) {
    throw new Error('UniverseRegistry requires at most one result per provider.');
  }
  const reviewed = input.reviewed.map(candidate => ProviderCandidateSchema.parse(candidate));
  const previous = input.previous ? UniverseRegistrySchema.parse(input.previous) : null;
  const issuer = reads.find(read => read.provider === 'xstocks');
  const issuerFresh = issuer?.status === 'ready' && issuer.lastSuccess !== null
    && issuer.lastSuccess !== previous?.lastProcessedIssuerSuccessAt;
  const incoming: Incoming[] = [
    ...reviewed.map(candidate => ({ source: 'reviewed-snapshot' as const, candidate })),
    ...reads.flatMap(read => read.status === 'ready' || (read.status === 'stale' && !previous)
      ? read.records.map(candidate => ({ source: read.provider, candidate })) : []),
  ];
  // Previous and reviewed identities are protected first if the aggregate input
  // ever reaches the ceiling. Every selection order is deterministic.
  const { allowed, truncation } = selectRegistryInputs(previous?.entries.length ?? 0, incoming);
  const entries = new Map<string, Entry>();
  for (const prior of previous?.entries ?? []) entries.set(prior.variant.mint, {
    ...prior, sources: [...prior.sources], conflicts: [...prior.conflicts],
  });
  const quarantine: UniverseRegistry['quarantine'] = [];
  for (const item of allowed) {
    const candidate = item.candidate;
    const variant = candidate.variant;
    const proofValid = issuerProofMatches(candidate, item.source);
    const existing = entries.get(variant.mint);
    if (!proofValid) {
      const review = conflict('issuer-proof-missing', [variant.mint], at);
      quarantine.push({ source: item.source, candidate, conflict: review });
      if (existing) addConflict(existing, review);
      continue;
    }
    if (!existing) {
      entries.set(variant.mint, { variant, catalogState: 'active', missingIssuerRefreshes: 0,
        sources: [item.source], conflicts: [] });
      continue;
    }
    const issue = sameMintConflict(existing.variant, variant);
    if (issue) {
      const review = conflict(issue, [variant.mint], at);
      addConflict(existing, review);
      quarantine.push({ source: item.source, candidate, conflict: review });
      continue;
    }
    if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
    // Exact issuer updates may replace a dated reviewed/prior identity. A tag can
    // add evidence, but cannot supply issuer, economics, or price fields.
    if (item.source === 'xstocks' || (item.source === 'reviewed-snapshot' && existing.variant.verification !== 'issuer-confirmed')) {
      const sameTokenMetadata = (!existing.variant.tokenProgram || !variant.tokenProgram
        || existing.variant.tokenProgram === variant.tokenProgram)
        && (existing.variant.decimals === null || variant.decimals === null
          || existing.variant.decimals === variant.decimals);
      existing.variant = SolanaStockVariantSchema.parse({ ...variant,
        reportedTokenizedCapUsd: variant.reportedTokenizedCapUsd ?? (sameTokenMetadata
          ? existing.variant.reportedTokenizedCapUsd : null),
        reportedLiquidityUsd: variant.reportedLiquidityUsd ?? (sameTokenMetadata
          ? existing.variant.reportedLiquidityUsd ?? null : null),
        reportedVolume24hUsd: variant.reportedVolume24hUsd ?? (sameTokenMetadata
          ? existing.variant.reportedVolume24hUsd ?? null : null),
        reportedMarketRetrievedAt: variant.reportedMarketRetrievedAt ?? (sameTokenMetadata
          ? existing.variant.reportedMarketRetrievedAt ?? null : null),
        evidence: uniqueEvidence(existing.variant.evidence, variant.evidence) });
    } else if (item.source === 'jupiter-stocks-tag') {
      const compatibleMetadata = (!existing.variant.tokenProgram || !variant.tokenProgram
        || existing.variant.tokenProgram === variant.tokenProgram)
        && (existing.variant.decimals === null || variant.decimals === null
          || existing.variant.decimals === variant.decimals);
      const liquidity = compatibleMetadata
        ? variant.reportedLiquidityUsd ?? existing.variant.reportedLiquidityUsd ?? null
        : existing.variant.reportedLiquidityUsd ?? null;
      const volume = compatibleMetadata
        ? variant.reportedVolume24hUsd ?? existing.variant.reportedVolume24hUsd ?? null
        : existing.variant.reportedVolume24hUsd ?? null;
      existing.variant = SolanaStockVariantSchema.parse({ ...existing.variant,
        evidence: uniqueEvidence(variant.evidence, existing.variant.evidence),
        reportedTokenizedCapUsd: compatibleMetadata
          ? variant.reportedTokenizedCapUsd ?? existing.variant.reportedTokenizedCapUsd
          : existing.variant.reportedTokenizedCapUsd,
        reportedLiquidityUsd: liquidity,
        reportedVolume24hUsd: volume,
        reportedMarketRetrievedAt: compatibleMetadata
          ? variant.reportedMarketRetrievedAt ?? existing.variant.reportedMarketRetrievedAt ?? null
          : existing.variant.reportedMarketRetrievedAt ?? null,
        availability: { ...existing.variant.availability,
          liquidity: liquidity === null ? existing.variant.availability.liquidity
            : decimal(liquidity).gt(0) ? 'available' : 'unavailable' },
      });
    }
  }
  // The live xStocks adapter includes only issuer-classified US equities/ETFs.
  // An older reviewed record with unknown class is outside that comparison set;
  // absence from this filtered read cannot prove it was delisted.
  const activeIssuerBefore = [...entries.values()].filter(entry => entry.variant.issuer === 'xstocks'
    && entry.variant.eligibility === 'eligible' && entry.catalogState !== 'delisted').length;
  const currentIssuerMints = new Set(issuer?.status === 'ready' ? issuer.records.map(row => row.variant.mint) : []);
  let missing = 0;
  if (issuerFresh && !truncation.truncated) for (const entry of entries.values()) {
    if (entry.variant.issuer !== 'xstocks' || entry.variant.eligibility !== 'eligible') continue;
    if (currentIssuerMints.has(entry.variant.mint)) {
      entry.missingIssuerRefreshes = 0;
      if (entry.conflicts.length === 0) entry.catalogState = 'active';
    } else {
      missing++;
      entry.missingIssuerRefreshes++;
      if (entry.conflicts.length === 0) entry.catalogState = entry.missingIssuerRefreshes >= 2 ? 'delisted' : 'pending-removal';
    }
  }
  const issuerEmpty = issuer?.status === 'ready' && issuer.records.length === 0;
  const shrink = { missing, priorIssuerMints: activeIssuerBefore,
    quarantined: issuerFresh && activeIssuerBefore > 0 && missing / activeIssuerBefore >= 0.9 };
  const sortedEntries = [...entries.values()].sort((a, b) => a.variant.mint.localeCompare(b.variant.mint));
  const assets = buildAssets(sortedEntries, at);
  const reviewedOnlyCount = sortedEntries.filter(entry => entry.catalogState !== 'delisted'
    && entry.sources.includes('reviewed-snapshot') && !currentIssuerMints.has(entry.variant.mint)).length;
  const status = !issuer && !previous && reviewed.length > 0 ? 'reviewed-fallback'
    : issuer?.status === 'ready' && issuer.lastSuccess !== null && reads.every(read => read.status === 'ready')
      && !truncation.truncated && !shrink.quarantined && quarantine.length === 0
      && reviewedOnlyCount === 0 && sortedEntries.every(entry => entry.conflicts.length === 0)
      ? 'complete' : 'degraded';
  return UniverseRegistrySchema.parse({
    builtAt: at, status, entries: sortedEntries, assets,
    inputCoverage: { candidateRecords: incoming.length,
      uniqueCandidateMints: new Set(incoming.map(item => item.candidate.variant.mint)).size,
      duplicateCandidateRecords: incoming.length - new Set(incoming.map(item => item.candidate.variant.mint)).size,
      reviewedCandidateRecords: reviewed.length },
    quarantine: quarantine.slice(0, REGISTRY_INPUT_CEILING),
    sourceStatuses: reads.map(read => ({ provider: read.provider, status: read.status,
      recordCount: read.records.length, lastSuccess: read.lastSuccess })),
    lastProcessedIssuerSuccessAt: issuerFresh ? issuer.lastSuccess : previous?.lastProcessedIssuerSuccessAt ?? null,
    issuerEmpty, reviewedOnlyCount, shrink, truncation,
  });
}

export function findRegistryMint(registry: UniverseRegistry, mint: string) {
  const exact = MarketMintSchema.parse(mint);
  return registry.entries.find(entry => entry.variant.mint === exact) ?? null;
}
