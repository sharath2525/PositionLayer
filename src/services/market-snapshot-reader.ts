import 'server-only';
import {
  CatalogVersionSchema, PublishedMarketSnapshotSchema,
  type CatalogVersion, type PublishedMarketSnapshot,
} from '@/domain/market-snapshot';
import type { MarketSnapshotStore } from './market-snapshot-store';

export type MarketSnapshotRead = {
  source: 'current' | 'previous' | 'local-previous' | 'bundled' | 'unavailable';
  snapshot: PublishedMarketSnapshot | null;
  degraded: boolean;
  reason: 'none' | 'current-stale' | 'current-invalid' | 'store-unavailable'
    | 'no-complete-snapshot' | 'bundled-catalog-only';
};

/** Explicit future cutover/rollback seam. Current public routes still call
 * their legacy reader directly; Phase 6 must prove a shared store and response
 * compatibility before selecting snapshot mode there. */
export async function readMarketWithRollback<T>(input: {
  mode: 'legacy' | 'snapshot';
  readLegacy: () => Promise<T>;
  snapshot: Parameters<typeof readMarketSnapshot>[0];
}): Promise<{ mode: 'legacy'; value: T } | { mode: 'snapshot'; value: MarketSnapshotRead }> {
  if (input.mode === 'legacy') return { mode: 'legacy', value: await input.readLegacy() };
  return { mode: 'snapshot', value: await readMarketSnapshot(input.snapshot) };
}

/** Read-only: never starts a worker, refresh, timer, or provider request.
 * A shared-store outage can use a bounded validated local prior; a cold
 * instance falls back to dated bundled identities with no fabricated prices. */
export async function readMarketSnapshot(input: {
  store: MarketSnapshotStore;
  bundledCatalog: CatalogVersion | null;
  localPrevious?: PublishedMarketSnapshot | null;
  nowMs: number;
  maxCurrentAgeMs?: number;
  maxPreviousAgeMs?: number;
}): Promise<MarketSnapshotRead> {
  const maxCurrent = input.maxCurrentAgeMs ?? 120_000;
  const maxPrevious = input.maxPreviousAgeMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
      !Number.isSafeInteger(maxCurrent) || maxCurrent <= 0 ||
      !Number.isSafeInteger(maxPrevious) || maxPrevious <= 0) {
    throw new Error('Invalid market snapshot reader clock or retention limit.');
  }
  let storeFailed = false;
  let currentInvalid = false;
  let currentId: string | null = null;
  try {
    const raw = await input.store.readCurrent();
    const parsed = raw ? PublishedMarketSnapshotSchema.safeParse(raw) : null;
    if (parsed?.success) {
      const snapshot = parsed.data;
      currentId = snapshot.id;
      const age = input.nowMs - Date.parse(snapshot.publishedAt);
      if (age >= -5_000) {
        const incomplete = snapshot.prices === null;
        const stale = age > maxCurrent || snapshot.catalog.registry.status !== 'complete';
        return { source: 'current', snapshot, degraded: incomplete || stale,
          reason: incomplete ? 'no-complete-snapshot' : stale ? 'current-stale' : 'none' };
      }
      currentInvalid = true;
    }
    if (raw !== null && !parsed?.success) currentInvalid = true;
  } catch { storeFailed = true; }
  if (!storeFailed) try {
    const history = await input.store.readHistory();
    for (const raw of history) {
      const parsed = PublishedMarketSnapshotSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id === currentId || !parsed.data.prices) continue;
      const age = input.nowMs - Date.parse(parsed.data.publishedAt);
      if (age >= -5_000 && age <= maxPrevious) {
        return { source: 'previous', snapshot: parsed.data, degraded: true,
          reason: currentInvalid ? 'current-invalid' : 'no-complete-snapshot' };
      }
    }
  } catch { storeFailed = true; }
  const local = input.localPrevious ? PublishedMarketSnapshotSchema.safeParse(input.localPrevious) : null;
  if (local?.success && local.data.prices &&
      input.nowMs - Date.parse(local.data.publishedAt) >= -5_000 &&
      input.nowMs - Date.parse(local.data.publishedAt) <= maxPrevious) {
    return { source: 'local-previous', snapshot: local.data, degraded: true,
      reason: storeFailed ? 'store-unavailable' : 'no-complete-snapshot' };
  }
  const bundled = input.bundledCatalog ? CatalogVersionSchema.safeParse(input.bundledCatalog) : null;
  if (bundled?.success) {
    const snapshot = PublishedMarketSnapshotSchema.parse({ id: 'bundled-catalog',
      catalog: bundled.data, prices: null, capCoverage: null, publishedAt: bundled.data.publishedAt });
    return { source: 'bundled', snapshot, degraded: true, reason: 'bundled-catalog-only' };
  }
  return { source: 'unavailable', snapshot: null, degraded: true,
    reason: storeFailed ? 'store-unavailable' : 'no-complete-snapshot' };
}
