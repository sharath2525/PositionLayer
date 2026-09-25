import { z } from 'zod';
import { decimal } from './amounts';
import { CoveredSolanaCapSchema, MarketMintSchema, MarketTimestampSchema } from './market-types';
import { VariantTokenObservationSchema } from './market-price-policy';
import { REGISTRY_INPUT_CEILING, UniverseRegistrySchema } from './universe-registry';

const VersionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);

export const CatalogVersionSchema = z.object({
  id: VersionIdSchema,
  registry: UniverseRegistrySchema,
  publishedAt: MarketTimestampSchema,
}).strict();

export const PriceSnapshotRowSchema = z.object({
  mint: MarketMintSchema,
  attempt: z.enum(['success', 'omitted', 'failed']),
  observation: VariantTokenObservationSchema.nullable(),
  // Retained observations keep their original successful retrieval time.
  retainedLastGood: z.boolean(),
}).strict().superRefine((row, context) => {
  if (row.attempt === 'success' && (row.observation === null || row.retainedLastGood)) {
    context.addIssue({ code: 'custom', message: 'Successful batch rows need a new observation.' });
  }
  if (row.attempt !== 'success' && row.retainedLastGood !== (row.observation !== null)) {
    context.addIssue({ code: 'custom', message: 'Failed/omitted rows must explicitly mark retained last-good data.' });
  }
  if (row.observation && (row.observation.mint !== row.mint || row.observation.currency !== 'USD'
      || row.observation.price === null || decimal(row.observation.price).lte(0))) {
    context.addIssue({ code: 'custom', message: 'A retained or successful observation must be a positive exact-mint USD price.' });
  }
});

export const CompletePriceSnapshotSchema = z.object({
  id: VersionIdSchema,
  catalogId: VersionIdSchema,
  startedAt: MarketTimestampSchema,
  completedAt: MarketTimestampSchema,
  targetMints: z.array(MarketMintSchema).min(1).max(REGISTRY_INPUT_CEILING),
  rows: z.array(PriceSnapshotRowSchema).max(REGISTRY_INPUT_CEILING),
  batchSize: z.number().int().min(1).max(50),
  totalBatches: z.number().int().nonnegative(),
  processedBatches: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  successfulCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  failedBatchCount: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, context) => {
  const targets = new Set(snapshot.targetMints);
  const rows = new Set(snapshot.rows.map(row => row.mint));
  const rowByMint = new Map(snapshot.rows.map(row => [row.mint, row]));
  let failedBatches = 0;
  for (let start = 0; start < snapshot.targetMints.length; start += snapshot.batchSize) {
    if (snapshot.targetMints.slice(start, start + snapshot.batchSize)
      .every(mint => rowByMint.get(mint)?.attempt === 'failed')) failedBatches++;
  }
  if (targets.size !== snapshot.targetMints.length || rows.size !== snapshot.rows.length
      || targets.size !== rows.size || [...rows].some(mint => !targets.has(mint))) {
    context.addIssue({ code: 'custom', message: 'Complete price snapshots require exactly one row per unique target mint.' });
  }
  if (snapshot.processedBatches !== snapshot.totalBatches ||
      snapshot.totalBatches !== Math.ceil(snapshot.targetMints.length / snapshot.batchSize) ||
      snapshot.successfulCount + snapshot.missingCount + snapshot.failedCount !== snapshot.rows.length ||
      snapshot.successfulCount !== snapshot.rows.filter(row => row.attempt === 'success').length ||
      snapshot.missingCount !== snapshot.rows.filter(row => row.attempt === 'omitted').length ||
      snapshot.failedCount !== snapshot.rows.filter(row => row.attempt === 'failed').length ||
      snapshot.failedBatchCount !== failedBatches) {
    context.addIssue({ code: 'custom', message: 'Every batch and target result must be accounted for before publication.' });
  }
  if (Date.parse(snapshot.completedAt) < Date.parse(snapshot.startedAt)
      || snapshot.durationMs !== Date.parse(snapshot.completedAt) - Date.parse(snapshot.startedAt)
      || snapshot.rows.some(row => row.observation?.retrievedAt
        && Date.parse(row.observation.retrievedAt) > Date.parse(snapshot.completedAt))) {
    context.addIssue({ code: 'custom', message: 'Snapshot time cannot precede its inputs or cycle start.' });
  }
});

export const CapCoverageVersionSchema = z.object({
  id: VersionIdSchema,
  catalogId: VersionIdSchema,
  priceId: VersionIdSchema,
  calculatedAt: MarketTimestampSchema,
  summary: CoveredSolanaCapSchema,
}).strict();

export const PublishedMarketSnapshotSchema = z.object({
  id: VersionIdSchema,
  catalog: CatalogVersionSchema,
  prices: CompletePriceSnapshotSchema.nullable(),
  capCoverage: CapCoverageVersionSchema.nullable(),
  publishedAt: MarketTimestampSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.prices && snapshot.prices.catalogId !== snapshot.catalog.id) {
    context.addIssue({ code: 'custom', message: 'Price snapshot must belong to the published catalog version.' });
  }
  if (snapshot.prices && Date.parse(snapshot.publishedAt) < Date.parse(snapshot.prices.completedAt)) {
    context.addIssue({ code: 'custom', message: 'A price cycle cannot be published before it completes.' });
  }
  if (snapshot.capCoverage && (!snapshot.prices || snapshot.capCoverage.catalogId !== snapshot.catalog.id
      || snapshot.capCoverage.priceId !== snapshot.prices.id)) {
    context.addIssue({ code: 'custom', message: 'Cap coverage must match both catalog and complete price versions.' });
  }
  if (snapshot.capCoverage && snapshot.prices &&
      (Date.parse(snapshot.capCoverage.calculatedAt) < Date.parse(snapshot.prices.completedAt)
        || Date.parse(snapshot.capCoverage.calculatedAt) > Date.parse(snapshot.publishedAt))) {
    context.addIssue({ code: 'custom', message: 'Cap coverage must be calculated after prices and before publication.' });
  }
  const catalogMints = new Set(snapshot.catalog.registry.entries.map(entry => entry.variant.mint));
  if (snapshot.prices?.targetMints.some(mint => !catalogMints.has(mint))) {
    context.addIssue({ code: 'custom', message: 'Every priced mint must belong to the referenced catalog.' });
  }
});

export const MarketWriterLeaseSchema = z.object({
  ownerId: VersionIdSchema,
  fencingToken: z.number().int().positive(),
  expiresAtMs: z.number().int().nonnegative(),
}).strict();

export const MarketCycleProgressSchema = z.object({
  cycleId: VersionIdSchema,
  catalogId: VersionIdSchema,
  fencingToken: z.number().int().positive(),
  state: z.enum(['running', 'backoff', 'complete', 'failed']),
  totalBatches: z.number().int().nonnegative(),
  processedBatches: z.number().int().nonnegative(),
  successfulCount: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  startedAt: MarketTimestampSchema,
  lastBatchAt: MarketTimestampSchema.nullable(),
  nextAttemptAt: MarketTimestampSchema.nullable(),
}).strict().superRefine((progress, context) => {
  if (progress.processedBatches > progress.totalBatches ||
      (progress.state === 'complete' && progress.processedBatches !== progress.totalBatches)) {
    context.addIssue({ code: 'custom', message: 'Progress cannot exceed or prematurely complete its batch total.' });
  }
});

export type CatalogVersion = z.infer<typeof CatalogVersionSchema>;
export type CompletePriceSnapshot = z.infer<typeof CompletePriceSnapshotSchema>;
export type CapCoverageVersion = z.infer<typeof CapCoverageVersionSchema>;
export type PublishedMarketSnapshot = z.infer<typeof PublishedMarketSnapshotSchema>;
export type MarketWriterLease = z.infer<typeof MarketWriterLeaseSchema>;
export type MarketCycleProgress = z.infer<typeof MarketCycleProgressSchema>;
