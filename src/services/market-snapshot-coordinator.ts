import 'server-only';
import { z } from 'zod';
import { decimal } from '@/domain/amounts';
import { MarketMintSchema } from '@/domain/market-types';
import { VariantTokenObservationSchema, type VariantTokenObservation } from '@/domain/market-price-policy';
import {
  CatalogVersionSchema, CapCoverageVersionSchema, CompletePriceSnapshotSchema,
  MarketCycleProgressSchema, PublishedMarketSnapshotSchema,
  type CatalogVersion, type CapCoverageVersion, type CompletePriceSnapshot, type MarketCycleProgress,
  type MarketWriterLease,
} from '@/domain/market-snapshot';
import type { MarketSnapshotStore } from './market-snapshot-store';

function samePriceIdentity(left: CatalogVersion['registry']['entries'][number]['variant'],
  right: CatalogVersion['registry']['entries'][number]['variant']) {
  return left.mint === right.mint && left.issuer === right.issuer
    && left.verification === right.verification && left.eligibility === right.eligibility
    && left.productClass === right.productClass && left.underlying.isin === right.underlying.isin
    && left.tokenProgram === right.tokenProgram && left.decimals === right.decimals
    && left.economicUnit.kind === right.economicUnit.kind
    && left.economicUnit.unitId === right.economicUnit.unitId
    && left.multiplier.status === right.multiplier.status
    && left.multiplier.current === right.multiplier.current;
}

const BatchReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), observations: z.array(VariantTokenObservationSchema).max(50) }).strict(),
  z.object({ status: z.literal('rate-limited'), retryAfterMs: z.number().int().min(0).max(300_000) }).strict(),
  z.object({ status: z.literal('failed') }).strict(),
]);
export type MarketBatchRead = z.infer<typeof BatchReadSchema>;
export type PriceCycleResult = {
  status: 'published' | 'lease-held' | 'lost-lease' | 'store-unavailable' | 'publication-rejected';
  snapshotId: string | null;
  batchCalls: number;
};

export type PriceCycleInput = {
  store: MarketSnapshotStore;
  ownerId: string;
  cycleId: string;
  catalog: CatalogVersion;
  targetMints: string[];
  readBatch: (mints: string[], context: { cycleId: string; batchIndex: number;
    attempt: number; signal: AbortSignal }) => Promise<MarketBatchRead>;
  deriveCapCoverage?: (prices: CompletePriceSnapshot) => Promise<CapCoverageVersion | null>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  batchSize?: number;
  paceMs?: number;
  leaseTtlMs?: number;
  requestTimeoutMs?: number;
  maxRateLimitRetries?: number;
};

/** Explicit writer entry point: never run this from a reader request. The
 * production route remains on the approved legacy path until rollout proof. */
export async function runMarketPriceCycle(input: PriceCycleInput): Promise<PriceCycleResult> {
  const catalog = CatalogVersionSchema.parse(input.catalog);
  const cycleId = CompletePriceSnapshotSchema.shape.id.parse(input.cycleId);
  const batchSize = input.batchSize ?? 50;
  const paceMs = input.paceMs ?? 2_100;
  const leaseTtlMs = input.leaseTtlMs ?? 30_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  const maxRetries = input.maxRateLimitRetries ?? 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50 ||
      !Number.isInteger(paceMs) || paceMs < 2_100 ||
      !Number.isInteger(leaseTtlMs) || leaseTtlMs < Math.max(5_000, paceMs * 2) || leaseTtlMs > 300_000 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs >= leaseTtlMs / 2 ||
      !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) {
    throw new Error('Invalid bounded market writer configuration.');
  }
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const targetMints = input.targetMints.map(mint => MarketMintSchema.parse(mint));
  const allowed = new Set(catalog.registry.entries.filter(entry => entry.catalogState !== 'delisted')
    .map(entry => entry.variant.mint));
  if (!targetMints.length || targetMints.length > 20_000 || new Set(targetMints).size !== targetMints.length
      || targetMints.some(mint => !allowed.has(mint))) {
    throw new Error('Price cycle targets require unique non-delisted exact catalog mints.');
  }
  const batches = Array.from({ length: Math.ceil(targetMints.length / batchSize) }, (_, index) =>
    targetMints.slice(index * batchSize, (index + 1) * batchSize));
  let lease: MarketWriterLease | null = null;
  let batchCalls = 0;
  const result = (status: PriceCycleResult['status'], snapshotId: string | null = null): PriceCycleResult =>
    ({ status, snapshotId, batchCalls });
  try {
    lease = await input.store.tryAcquireLease(input.ownerId, now(), leaseTtlMs);
    if (!lease) return result('lease-held');
    const initial = await input.store.readCurrent();
    const prior = initial ? PublishedMarketSnapshotSchema.parse(initial) : null;
    const expectedCurrentId = prior?.id ?? null;
    const priorEntries = new Map(prior?.catalog.registry.entries.map(entry => [entry.variant.mint, entry.variant]) ?? []);
    const currentEntries = new Map(catalog.registry.entries.map(entry => [entry.variant.mint, entry.variant]));
    const priorPrices = new Map(prior?.prices?.rows.flatMap(row => {
      const previous = priorEntries.get(row.mint);
      const current = currentEntries.get(row.mint);
      return row.observation && previous && current && samePriceIdentity(previous, current)
        ? [[row.mint, row.observation] as const] : [];
    }) ?? []);
    const startedAt = new Date(now()).toISOString();
    let lastCallAt: number | null = null;
    let lastBatchAt: string | null = null;
    let success = 0, missing = 0, failed = 0, failedBatches = 0;
    const rows: z.infer<typeof CompletePriceSnapshotSchema>['rows'] = [];
    let progress: MarketCycleProgress = MarketCycleProgressSchema.parse({
      cycleId, catalogId: catalog.id, fencingToken: lease.fencingToken, state: 'running',
      totalBatches: batches.length, processedBatches: 0,
      successfulCount: 0, missingCount: 0, failedCount: 0,
      startedAt, lastBatchAt: null, nextAttemptAt: null,
    });
    if (!await input.store.writeProgress(progress, lease, now())) return result('lost-lease');

    const renew = async () => {
      lease = await input.store.renewLease(lease!, now(), leaseTtlMs);
      return lease !== null;
    };
    const waitFenced = async (durationMs: number) => {
      let remaining = Math.max(0, durationMs);
      while (remaining > 0) {
        if (!await renew()) return false;
        const chunk = Math.min(remaining, Math.floor(leaseTtlMs / 2));
        await wait(chunk);
        remaining -= chunk;
        if (!await renew()) return false;
      }
      return true;
    };

    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];
      let response: MarketBatchRead = { status: 'failed' };
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const spacing = lastCallAt === null ? 0 : Math.max(0, paceMs - (now() - lastCallAt));
        if (!await waitFenced(spacing) || !await renew()) return result('lost-lease');
        lastCallAt = now();
        batchCalls++;
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          const timed = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { controller.abort(); reject(new Error('Market batch timed out.')); }, requestTimeoutMs);
          });
          const parsed = BatchReadSchema.parse(await Promise.race([
            input.readBatch(batch, { cycleId, batchIndex: index, attempt, signal: controller.signal }), timed,
          ]));
          if (parsed.status === 'ok') {
            const expected = new Set(batch);
            const seen = new Set<string>();
            if (parsed.observations.some(item => {
              if (!expected.has(item.mint) || seen.has(item.mint) || item.currency !== 'USD'
                  || item.price === null || decimal(item.price).lte(0)
                  || !item.retrievedAt || Date.parse(item.retrievedAt) > now()) return true;
              seen.add(item.mint);
              return false;
            })) {
              response = { status: 'failed' };
            } else response = parsed;
          } else response = parsed;
        } catch { response = { status: 'failed' }; }
        finally { if (timeout) clearTimeout(timeout); }
        if (!await renew()) return result('lost-lease');
        if (response.status === 'rate-limited' && attempt < maxRetries) {
          progress = MarketCycleProgressSchema.parse({ ...progress, state: 'backoff',
            nextAttemptAt: new Date(now() + response.retryAfterMs).toISOString() });
          if (!await input.store.writeProgress(progress, lease!, now())
              || !await waitFenced(response.retryAfterMs)) return result('lost-lease');
          continue;
        }
        break;
      }
      const current = response.status === 'ok'
        ? new Map(response.observations.map(item => [item.mint, item])) : new Map<string, VariantTokenObservation>();
      if (response.status !== 'ok') failedBatches++;
      for (const mint of batch) {
        const fresh = current.get(mint);
        const attempt = fresh ? 'success' : response.status === 'ok' ? 'omitted' : 'failed';
        const observation = fresh ?? priorPrices.get(mint) ?? null;
        rows.push({ mint, attempt, observation, retainedLastGood: !fresh && observation !== null });
        if (attempt === 'success') success++;
        else if (attempt === 'omitted') missing++;
        else failed++;
      }
      lastBatchAt = new Date(now()).toISOString();
      progress = MarketCycleProgressSchema.parse({ ...progress, state: 'running',
        processedBatches: index + 1, successfulCount: success, missingCount: missing,
        failedCount: failed, lastBatchAt, nextAttemptAt: null });
      if (!await input.store.writeProgress(progress, lease!, now())) return result('lost-lease');
    }
    if (!await renew()) return result('lost-lease');
    const completedAt = new Date(now()).toISOString();
    const prices = CompletePriceSnapshotSchema.parse({ id: cycleId, catalogId: catalog.id,
      startedAt, completedAt, targetMints, rows, batchSize, totalBatches: batches.length,
      processedBatches: batches.length, successfulCount: success,
      missingCount: missing, failedCount: failed, failedBatchCount: failedBatches,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt) });
    // Optional enrichment cannot prevent a complete price snapshot. A caller
    // must supply verified cap inputs; absent/failed evidence stays null.
    let cap: CapCoverageVersion | null = null;
    if (input.deriveCapCoverage) try {
      const derived = await input.deriveCapCoverage(prices);
      cap = derived ? CapCoverageVersionSchema.parse(derived) : null;
      if (cap && (cap.catalogId !== catalog.id || cap.priceId !== cycleId
          || Date.parse(cap.calculatedAt) < Date.parse(prices.completedAt)
          || Date.parse(cap.calculatedAt) > now())) cap = null;
    } catch { cap = null; }
    if (!await renew()) return result('lost-lease');
    const published = PublishedMarketSnapshotSchema.parse({ id: cycleId,
      catalog, prices, capCoverage: cap, publishedAt: new Date(now()).toISOString() });
    if (!await input.store.publish(published, expectedCurrentId, lease!, now())) {
      return result('publication-rejected');
    }
    progress = MarketCycleProgressSchema.parse({ ...progress, state: 'complete' });
    // Publication is already committed. A progress write failure cannot roll it
    // back or turn it into a partially published price snapshot.
    try { await input.store.writeProgress(progress, lease!, now()); } catch { /* best-effort metadata */ }
    return result('published', published.id);
  } catch {
    return result('store-unavailable');
  } finally {
    if (lease) try { await input.store.releaseLease(lease); } catch { /* lease expiry is the fallback */ }
  }
}
