import 'server-only';
import { randomUUID } from 'node:crypto';
import { readJupiterPriceV3Batch } from '@/adapters/market/jupiter-price-v3-batch';
import { readJupiterStocksTagCandidates } from '@/adapters/market/jupiter-discovery';
import { readReviewedMarketCandidates } from '@/adapters/market/reviewed-candidates';
import { snapshotXstockAssets } from '@/adapters/market/stocks';
import { readXstocksIssuerCandidates } from '@/adapters/market/xstocks-issuer';
import { calculateCoveredSolanaCap } from '@/domain/market-cap-policy';
import { canQueryExactIssuerPrice } from '@/domain/market-price-policy';
import { CatalogVersionSchema, type CatalogVersion } from '@/domain/market-snapshot';
import { type ProviderReadResult } from '@/domain/market-provider';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { recordMarketEvent } from '@/services/monitoring/log-manager';
import { runMarketPriceCycle, type MarketBatchRead, type PriceCycleResult } from './market-snapshot-coordinator';
import { getProcessMarketSnapshotStore, type MarketSnapshotStore } from './market-snapshot-store';

const CATALOG_REFRESH_MS = 60 * 60_000;
const MIN_CYCLE_MS = 60_000;

type MarketV2State = {
  started: boolean; running: boolean; timer: ReturnType<typeof setTimeout> | null;
  catalog: CatalogVersion | null; catalogLoadedAt: number; lastResult: PriceCycleResult | null;
};
type EngineGlobal = typeof globalThis & { __positionLayerMarketV2?: MarketV2State };
const root = globalThis as EngineGlobal;
root.__positionLayerMarketV2 ??= { started: false, running: false, timer: null,
  catalog: null, catalogLoadedAt: 0, lastResult: null };
const state = root.__positionLayerMarketV2;

/** Dated issuer evidence only; safe on a cold reader and makes no network calls. */
export function bundledMarketV2Catalog(): CatalogVersion {
  const existing = (globalThis as typeof globalThis & { __positionLayerBundledV2?: CatalogVersion }).__positionLayerBundledV2;
  // Next dev hot reload may preserve a global bundle built with an older
  // contract. Never let that stale object make the cold fallback disappear.
  if (existing && CatalogVersionSchema.safeParse(existing).success) return existing;
  const at = snapshotXstockAssets().verifiedAt;
  const registry = buildUniverseRegistry({ reviewed: readReviewedMarketCandidates(), reads: [], now: at });
  const catalog = { id: 'reviewed-catalog-202609', registry, publishedAt: at };
  (globalThis as typeof globalThis & { __positionLayerBundledV2?: CatalogVersion }).__positionLayerBundledV2 = catalog;
  return catalog;
}

/** The global Price V3 queue may observe any active exact issuer mint. Class
 * resolution remains mandatory for sensitive calculations, but is not needed
 * to display a same-mint token-unit market observation. */
export function priceTargetMints(catalog: CatalogVersion): string[] {
  return catalog.registry.entries.filter(canQueryExactIssuerPrice)
    .map(entry => entry.variant.mint).sort();
}

export async function refreshMarketV2Catalog(input: {
  previous: CatalogVersion | null; readIssuer?: () => Promise<ProviderReadResult>;
  readTag?: () => Promise<ProviderReadResult>; nowMs?: number;
}): Promise<CatalogVersion> {
  const now = input.nowMs ?? Date.now();
  const results = await Promise.allSettled([(input.readIssuer ?? readXstocksIssuerCandidates)(),
    (input.readTag ?? readJupiterStocksTagCandidates)()]);
  const reads = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const registry = buildUniverseRegistry({ reviewed: readReviewedMarketCandidates(),
    previous: input.previous?.registry ?? null, reads, now: new Date(now).toISOString() });
  // A large unexpected removal cannot replace a validated catalog. The
  // issuer adapter's own stale cache remains an independent fallback.
  if (registry.shrink.quarantined && input.previous) return input.previous;
  return { id: `catalog-${randomUUID()}`, registry, publishedAt: new Date(now).toISOString() };
}

/** Explicit writer operation. Readers and browser reloads never call this. */
export async function runMarketV2Once(input: {
  catalog: CatalogVersion; store: MarketSnapshotStore;
  readBatch?: (mints: string[], signal: AbortSignal) => Promise<MarketBatchRead>;
  now?: () => number; wait?: (ms: number) => Promise<void>;
}): Promise<PriceCycleResult> {
  const targets = priceTargetMints(input.catalog);
  if (targets.length === 0) return { status: 'publication-rejected', snapshotId: null, batchCalls: 0 };
  const variants = new Map(input.catalog.registry.entries.map(entry => [entry.variant.mint, entry.variant]));
  return runMarketPriceCycle({ store: input.store, ownerId: 'market-v2-process-writer',
    cycleId: `cycle-${randomUUID()}`, catalog: input.catalog, targetMints: targets,
    now: input.now, wait: input.wait, batchSize: 50, paceMs: 2_100,
    requestTimeoutMs: 20_000, leaseTtlMs: 60_000, maxRateLimitRetries: 2,
    readBatch: (mints, context) => input.readBatch
      ? input.readBatch(mints, context.signal)
      : readJupiterPriceV3Batch({ mints, variants, signal: context.signal }),
    deriveCapCoverage: async prices => ({ id: `cap-${prices.id}`,
      catalogId: input.catalog.id, priceId: prices.id,
      calculatedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
      // No verified per-Solana-mint circulating-supply feed has been approved.
      // This produces an explicit unavailable/zero-coverage result, never a
      // fictitious capitalization or a substitution from all-chain supply.
      summary: calculateCoveredSolanaCap({ registry: input.catalog.registry,
        observations: prices.rows.flatMap(row => row.observation ? [row.observation] : []),
        supplies: [], now: input.now?.() ?? Date.now() }).summary,
    }),
  });
}

function schedule(delayMs: number) {
  if (!state.started || state.timer) return;
  state.timer = setTimeout(() => { state.timer = null; void tick(); }, delayMs);
  state.timer.unref?.();
}

async function tick() {
  if (!state.started || state.running) return;
  state.running = true;
  const started = Date.now();
  try {
    if (state.catalog && !CatalogVersionSchema.safeParse(state.catalog).success) {
      state.catalog = null;
      state.catalogLoadedAt = 0;
    }
    if (!state.catalog || started - state.catalogLoadedAt >= CATALOG_REFRESH_MS) {
      state.catalog = await refreshMarketV2Catalog({ previous: state.catalog });
      state.catalogLoadedAt = Date.now();
    }
    if (priceTargetMints(state.catalog).length === 0) {
      recordMarketEvent({ severity: 'WARN', provider: 'SYSTEM', operation: 'price_worker',
        status: 'STALE_DATA', errorCode: 'STALE',
        message: 'Versioned catalog has no active exact issuer mints; previous snapshots remain available.' });
    } else {
      state.lastResult = await runMarketV2Once({ catalog: state.catalog,
        store: getProcessMarketSnapshotStore() });
    }
  } catch {
    recordMarketEvent({ severity: 'ERROR', provider: 'SYSTEM', operation: 'price_worker',
      status: 'NETWORK_ERROR', errorCode: 'UNKNOWN',
      message: 'Versioned market cycle failed; the last complete snapshot was retained.' });
  } finally {
    state.running = false;
    schedule(Math.max(5_000, MIN_CYCLE_MS - (Date.now() - started)));
  }
}

/** Opt-in for a proven persistent, single-process Node host only. Never enable
 * this process-local lease as a multi-instance/serverless global writer. */
export function startProcessMarketV2Engine() {
  if (process.env.MARKET_V2_WRITER_ENABLED !== 'true' || process.env.MARKET_V2_WRITER_ORIGIN || state.started) return;
  state.started = true;
  schedule(1_000);
}

export function marketV2EngineStatus() {
  return { started: state.started, running: state.running, catalogId: state.catalog?.id ?? null,
    lastResult: state.lastResult };
}
