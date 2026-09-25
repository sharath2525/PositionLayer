import 'server-only';
import { JupiterApiError } from '@/adapters/jupiter-api/client';
import {
  activeSolanaXstockAssets,
  mergeJupiterStockMetadata,
  mergeSolanaMintMetadata,
  mergeVisiblePrices,
  mergeVisiblePricesV2,
  normalizeStockUniverse,
  readJupiterLendVaults,
  readJupiterMarketPrices,
  readJupiterStockMetadataByMint,
  readSolanaMintMetadata,
  readXstockMultiplier,
  readXstockPrice,
  readXstockReserve,
  readXstockSupply,
  readXstocksSolanaAssets,
  selectTopIssuerRecords,
  snapshotXstockAssets,
  splitPriceBatches,
  type JupiterMarketPrice,
  type JupiterLendVault,
} from '@/adapters/market/stocks';
import {
  minimumMeteoraLiquidityUsd,
  readMeteoraPoolDetail,
  readMeteoraPoolIndexes,
  selectMeteoraPool,
  type MeteoraPool,
  type MeteoraPoolIndex,
  type MeteoraProtocol,
} from '@/adapters/meteora/market';
import {
  StockMarketDetailSchema,
  StockMarketPageSchema,
  StockMarketRecordSchema,
  selectStockMarketPage,
  summarizeStockMarket,
  type StockMarketPage,
  type StockMarketQuery,
  type StockMarketRecord,
} from '@/domain/stocks';
import { estimatePremiumDiscount } from '@/domain/stock-intelligence';
import { decimal } from '@/domain/amounts';
import { recordMarketEvent } from '@/services/monitoring/log-manager';
import {
  MarketEvidenceSchema,
  compareMarketSources,
  projectJupiterObservation,
  type MarketSourceComparison,
  type MarketUpdateFailure,
  type PoolObservation,
} from '@/domain/market-observations';

type CacheState = 'hit' | 'miss' | 'shared-inflight' | 'stale';
type CacheRead<T> = { value: T; state: CacheState; expiresAt: number };

export class SharedResourceCache<T> {
  private entry: { value: T; expiresAt: number; staleUntil: number } | null = null;
  private inflight: Promise<T> | null = null;
  constructor(private readonly ttlMs: number, private readonly staleMs: number) {}
  replace(value: T, ttlMs = this.ttlMs) {
    const now = Date.now();
    this.entry = { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs + this.staleMs };
  }
  peek() { return this.entry?.value ?? null; }
  async read(loader: () => Promise<T>, now = Date.now()): Promise<CacheRead<T>> {
    if (this.entry && this.entry.expiresAt > now) return { value: this.entry.value, state: 'hit', expiresAt: this.entry.expiresAt };
    if (this.inflight) {
      try {
        const value = await this.inflight;
        return { value, state: 'shared-inflight', expiresAt: this.entry?.expiresAt || now + this.ttlMs };
      } catch (error) {
        if (this.entry && this.entry.staleUntil > now) {
          recordMarketEvent({ severity: 'WARN', provider: 'CACHE', operation: 'cache_load', status: 'CACHE_STALE_FALLBACK', errorCode: 'CACHE_LOAD', message: 'Cache refresh failed; bounded stale data was served.', fallbackUsed: 'bounded-stale-cache' });
          return { value: this.entry.value, state: 'stale', expiresAt: this.entry.expiresAt };
        }
        recordMarketEvent({ severity: 'ERROR', provider: 'CACHE', operation: 'cache_load', status: 'CACHE_LOAD_FAILED', errorCode: 'CACHE_LOAD', message: 'Cache load failed with no eligible stale value.' });
        throw error;
      }
    }
    const stale = this.entry && this.entry.staleUntil > now ? this.entry : null;
    this.inflight = loader();
    try {
      const value = await this.inflight;
      const loadedAt = Date.now();
      this.entry = { value, expiresAt: loadedAt + this.ttlMs, staleUntil: loadedAt + this.ttlMs + this.staleMs };
      return { value, state: 'miss', expiresAt: this.entry.expiresAt };
    } catch (error) {
      if (stale) {
        recordMarketEvent({ severity: 'WARN', provider: 'CACHE', operation: 'cache_load', status: 'CACHE_STALE_FALLBACK', errorCode: 'CACHE_LOAD', message: 'Cache refresh failed; bounded stale data was served.', fallbackUsed: 'bounded-stale-cache' });
        return { value: stale.value, state: 'stale', expiresAt: stale.expiresAt };
      }
      recordMarketEvent({ severity: 'ERROR', provider: 'CACHE', operation: 'cache_load', status: 'CACHE_LOAD_FAILED', errorCode: 'CACHE_LOAD', message: 'Cache load failed with no eligible stale value.' });
      throw error;
    } finally {
      this.inflight = null;
    }
  }
  clear() { this.entry = null; this.inflight = null; }
}

export class SharedKeyedResourceCache<T> {
  private readonly entries = new Map<string, SharedResourceCache<T>>();
  private readonly failedUntil = new Map<string, number>();
  constructor(private readonly ttlMs: number, private readonly staleMs: number, private readonly maxKeys: number, private readonly retryCooldownMs = 0) {}
  async read(key: string, loader: () => Promise<T>, now = Date.now()) {
    if ((this.failedUntil.get(key) ?? 0) > now) throw Error('Provider retry is cooling down.');
    let cache = this.entries.get(key);
    if (!cache) {
      if (this.entries.size >= this.maxKeys) {
        const oldest = this.entries.keys().next().value!;
        this.entries.delete(oldest);
        this.failedUntil.delete(oldest);
      }
      cache = new SharedResourceCache<T>(this.ttlMs, this.staleMs);
      this.entries.set(key, cache);
    } else {
      this.entries.delete(key);
      this.entries.set(key, cache);
    }
    try {
      const result = await cache.read(loader, now);
      this.failedUntil.delete(key);
      return result;
    } catch (error) {
      if (this.retryCooldownMs > 0) this.failedUntil.set(key, Date.now() + this.retryCooldownMs);
      throw error;
    }
  }
  get size() { return this.entries.size; }
  clear() { this.entries.clear(); this.failedUntil.clear(); }
}

type UniverseSnapshot = {
  records: StockMarketRecord[];
  rankingCandidates?: StockMarketRecord[];
  xstocks: 'ready' | 'stale' | 'unavailable';
  jupiterTokens: 'ready' | 'fallback' | 'unavailable';
  updatedAt: string;
  issues: string[];
};

type PriceWorkerState = {
  started: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  mints: string[];
  signature: string;
  priority: string[];
  cycleBatches: string[][];
  nextBatchIndex: number;
  prices: Map<string, JupiterMarketPrice>;
  failures: Map<string, MarketUpdateFailure>;
  lastCycleStartedAt: number | null;
  lastCycleCompletedAt: number | null;
  lastBatchAt: number | null;
  nextRunAt: number | null;
  backoffUntil: number | null;
  consecutiveFailures: number;
  lastIssue: string | null;
};

type MarketGlobalState = {
  version: string;
  universe: SharedResourceCache<UniverseSnapshot>;
  worker: PriceWorkerState;
  issuerPrices: SharedKeyedResourceCache<Awaited<ReturnType<typeof readXstockPrice>>>;
  multipliers: SharedKeyedResourceCache<Awaited<ReturnType<typeof readXstockMultiplier>>>;
  supplies: SharedKeyedResourceCache<Awaited<ReturnType<typeof readXstockSupply>>>;
  reserves: SharedKeyedResourceCache<Awaited<ReturnType<typeof readXstockReserve>>>;
  lendVaults: SharedResourceCache<{ vaults: JupiterLendVault[]; retrievedAt: string }>;
  meteoraIndex: SharedResourceCache<MeteoraPoolIndex>;
  meteoraPools: SharedKeyedResourceCache<{ pool: MeteoraPool; protocol: MeteoraProtocol; retrievedAt: string }>;
  comparisonStates: Map<string, { status: MarketSourceComparison['status']; divergedCount: number; agreedCount: number }>;
  catalogSeeded: boolean;
  catalogInflight: Promise<void> | null;
  catalogNextAttemptAt: number;
  catalogFailures: number;
  metadataInflight: Promise<void> | null;
  metadataNextAttemptAt: number;
  counts: { universeLoads: number; metadataLoads: number; solanaMintLoads: number; priceLoads: number; priceCycles: number; priceFailures: number; issuerPriceLoads: number; multiplierLoads: number; detailLoads: number; lendLoads: number; meteoraIndexLoads: number; meteoraDetailLoads: number };
};

const MARKET_LIMIT = 300;
const PRICE_BATCH_SIZE = 50;
const PRICE_CYCLE_MS = 30_000;
export const VISIBLE_INTELLIGENCE_LIMIT = 8;
const MARKET_CACHE_VERSION = 'issuer-snapshot-300-meteora-lkg-v8';

function freshWorkerState(): PriceWorkerState {
  return {
    started: false, running: false, timer: null, mints: [], signature: '', priority: [], cycleBatches: [], nextBatchIndex: 0, prices: new Map(), failures: new Map(),
    lastCycleStartedAt: null, lastCycleCompletedAt: null, lastBatchAt: null, nextRunAt: null,
    backoffUntil: null, consecutiveFailures: 0, lastIssue: null,
  };
}

const root = globalThis as typeof globalThis & { positionLayerStockMarket?: MarketGlobalState };
if (root.positionLayerStockMarket?.version !== MARKET_CACHE_VERSION) {
  if (root.positionLayerStockMarket?.worker.timer) clearTimeout(root.positionLayerStockMarket.worker.timer);
  if (root.positionLayerStockMarket?.worker) root.positionLayerStockMarket.worker.started = false;
  root.positionLayerStockMarket = {
    version: MARKET_CACHE_VERSION,
    universe: new SharedResourceCache<UniverseSnapshot>(24 * 60 * 60_000, 6 * 60 * 60_000),
    worker: freshWorkerState(),
    issuerPrices: new SharedKeyedResourceCache(30_000, 2 * 60_000, 350, 60_000),
    multipliers: new SharedKeyedResourceCache(5 * 60_000, 60 * 60_000, 350, 60_000),
    supplies: new SharedKeyedResourceCache(10 * 60_000, 60 * 60_000, 350),
    reserves: new SharedKeyedResourceCache(10 * 60_000, 60 * 60_000, 350),
    lendVaults: new SharedResourceCache(2 * 60_000, 10 * 60_000),
    meteoraIndex: new SharedResourceCache(10 * 60_000, 30 * 60_000),
    meteoraPools: new SharedKeyedResourceCache(60_000, 5 * 60_000, 300),
    comparisonStates: new Map(),
    catalogSeeded: false,
    catalogInflight: null,
    catalogNextAttemptAt: 0,
    catalogFailures: 0,
    metadataInflight: null,
    metadataNextAttemptAt: 0,
    counts: { universeLoads: 0, metadataLoads: 0, solanaMintLoads: 0, priceLoads: 0, priceCycles: 0, priceFailures: 0, issuerPriceLoads: 0, multiplierLoads: 0, detailLoads: 0, lendLoads: 0, meteoraIndexLoads: 0, meteoraDetailLoads: 0 },
  };
}
const state = root.positionLayerStockMarket;

export function isMarketResolverV2Enabled() { return process.env.MARKET_RESOLVER_V2 !== 'false'; }
export function isMeteoraMarketEnabled() { return process.env.METEORA_MARKET_ENABLED !== 'false'; }

function resolvedMarketRecords(records: StockMarketRecord[], now = Date.now()) {
  return isMarketResolverV2Enabled()
    ? mergeVisiblePricesV2(records, state.worker.prices, state.worker.failures, now)
    : mergeVisiblePrices(records, state.worker.prices);
}

export function mergePriceBatchIntoLkg(
  cache: Map<string, JupiterMarketPrice>,
  failures: Map<string, MarketUpdateFailure>,
  requestedMints: string[],
  updates: Map<string, JupiterMarketPrice>,
  resolverV2 = true,
  now = Date.now(),
) {
  for (const mint of requestedMints) {
    const update = updates.get(mint);
    if (update) {
      cache.set(mint, update);
      failures.delete(mint);
    } else if (resolverV2) {
      failures.set(mint, {
        kind: 'omitted', at: new Date(now).toISOString(),
        message: 'Jupiter omitted this mint from the latest validated batch.',
      });
    } else {
      cache.delete(mint);
      failures.delete(mint);
    }
  }
}

function safeMessage(error: unknown, provider: string) {
  if (error instanceof JupiterApiError) {
    if (error.kind === 'rate-limited') return `${provider} rate limit reached${error.retryAfterSeconds === null ? '' : `; retry after ${error.retryAfterSeconds}s`}.`;
    if (error.kind === 'timeout') return `${provider} timed out.`;
    if (error.kind === 'malformed') return `${provider} response failed validation.`;
  }
  return `${provider} is temporarily unavailable.`;
}

export function issuerSnapshotUniverse(): UniverseSnapshot {
  const snapshot = snapshotXstockAssets();
  const records = selectTopIssuerRecords(normalizeStockUniverse(activeSolanaXstockAssets(snapshot.assets), [], snapshot.verifiedAt), MARKET_LIMIT);
  return {
    records, xstocks: 'stale', jupiterTokens: 'unavailable', updatedAt: snapshot.verifiedAt,
    issues: [`Showing ${records.length} exact-mint issuer identities from the reviewed ${snapshot.verifiedAt.slice(0, 10)} catalog snapshot while live sources refresh. Trading status may have changed since verification.`],
  };
}

/** Split-deployment outage fallback. Pure reviewed identity projection: no
 * provider request, timer, price worker, or synthetic market observation. */
export function readOfflineStockMarketPage(query: StockMarketQuery): StockMarketPage {
  const snapshot = issuerSnapshotUniverse();
  const selected = selectStockMarketPage(snapshot.records, query);
  return StockMarketPageSchema.parse({
    status: 'stale', records: selected.records,
    pagination: { page: selected.page, pageSize: query.pageSize,
      total: selected.total, totalPages: selected.totalPages },
    summary: summarizeStockMarket(snapshot.records),
    providers: { xstocks: 'stale', jupiterTokens: 'unavailable', jupiterPrice: 'unavailable',
      xstocksIntelligence: 'unavailable', jupiterLend: 'unavailable' },
    cache: { universe: 'stale', visiblePrices: 'unavailable', universeExpiresAt: snapshot.updatedAt,
      priceWorker: priceWorkerSnapshot() },
    updatedAt: snapshot.updatedAt,
    issues: [...snapshot.issues, 'The shared market host is temporarily unavailable; showing reviewed identities without live prices.'],
  });
}

export function readOfflineStockMarketDetail(mint: string) {
  const record = issuerSnapshotUniverse().records.find(item => item.mint === mint);
  return record ? StockMarketDetailSchema.parse({ status: 'stale', record,
    issues: ['The shared market host is temporarily unavailable; this reviewed identity has no live price or intelligence.'] }) : null;
}

function seedCatalog() {
  if (state.catalogSeeded) return;
  state.universe.replace(issuerSnapshotUniverse());
  state.catalogSeeded = true;
}

async function loadUniverse(signal?: AbortSignal): Promise<UniverseSnapshot> {
  state.counts.universeLoads++;
  const retrievedAt = new Date().toISOString();
  const issues: string[] = [];
  const xstocks = activeSolanaXstockAssets(await readXstocksSolanaAssets(signal));
  const candidates = normalizeStockUniverse(xstocks, [], retrievedAt).filter(record => record.issuerVerified);
  const allMints = [...new Set(candidates.map(record => record.mint))];
  if (allMints.length < MARKET_LIMIT) throw Error('Issuer registry has fewer than 300 active Solana deployments; retaining the reviewed complete snapshot.');
  let jupiterTokens: Awaited<ReturnType<typeof readJupiterStockMetadataByMint>> = [];
  let metadataState: UniverseSnapshot['jupiterTokens'] = 'ready';
  try {
    state.counts.metadataLoads += Math.ceil(allMints.length / 100);
    jupiterTokens = await readJupiterStockMetadataByMint(allMints, signal);
    if (jupiterTokens.length === 0) {
      metadataState = 'unavailable';
      issues.push('Jupiter returned no exact-mint metadata; issuer identities remain available.');
    }
  } catch (error) {
    metadataState = 'unavailable';
    issues.push(safeMessage(error, 'Jupiter token metadata'));
  }
  const records = selectTopIssuerRecords(normalizeStockUniverse(xstocks, jupiterTokens, retrievedAt), MARKET_LIMIT);
  if (records.length < MARKET_LIMIT) throw Error('Live issuer ranking produced fewer than 300 verified mints.');
  if (jupiterTokens.length < allMints.length) issues.push(`${allMints.length - jupiterTokens.length} issuer mints lack Jupiter token metadata; exact issuer identity remains available.`);
  return {
    records,
    rankingCandidates: metadataState === 'ready' ? undefined : candidates,
    xstocks: 'ready',
    jupiterTokens: metadataState,
    updatedAt: retrievedAt,
    issues,
  };
}

function ensureCatalogRefresh() {
  if (state.catalogInflight || Date.now() < state.catalogNextAttemptAt) return;
  state.catalogNextAttemptAt = Date.now() + 60_000;
  state.catalogInflight = loadUniverse().then(snapshot => {
    state.universe.replace(snapshot);
    updateWorkerUniverse(snapshot.records);
    state.catalogFailures = 0;
    state.catalogNextAttemptAt = Date.now() + 60 * 60_000;
    recordMarketEvent({ severity: 'INFO', provider: 'XSTOCKS', operation: 'asset_registry', status: 'RECOVERED', errorCode: null, message: 'The complete live issuer catalog replaced the reviewed snapshot; Jupiter metadata remains independently gated.' });
    if (snapshot.jupiterTokens !== 'ready') ensureSnapshotMetadata(snapshot);
  }).catch(error => {
    state.catalogFailures++;
    const retryAfter = error instanceof JupiterApiError && error.kind === 'rate-limited' ? error.retryAfterSeconds : null;
    state.catalogNextAttemptAt = Date.now() + Math.max(60_000, priceWorkerBackoffMs(state.catalogFailures, retryAfter));
    recordMarketEvent({ severity: 'WARN', provider: 'XSTOCKS', operation: 'asset_registry', status: 'CACHE_STALE_FALLBACK', errorCode: 'CACHE_LOAD', message: 'Live catalog refresh failed; the complete dated issuer snapshot remains available.', fallbackUsed: 'bounded-stale-cache' });
    const current = state.universe.peek();
    if (current?.xstocks === 'stale') ensureSnapshotMetadata(current);
  }).finally(() => { state.catalogInflight = null; });
}

function ensureSnapshotMetadata(snapshot: UniverseSnapshot) {
  if (snapshot.jupiterTokens === 'ready' || state.metadataInflight || Date.now() < state.metadataNextAttemptAt) return;
  state.metadataNextAttemptAt = Date.now() + 60_000;
  state.metadataInflight = (async () => {
    // Rank the complete issuer snapshot, not an alphabetically selected first 300.
    const allRecords = snapshot.rankingCandidates ?? normalizeStockUniverse(activeSolanaXstockAssets(snapshotXstockAssets().assets), [], snapshot.updatedAt);
    const mints = allRecords.map(record => record.mint);
    try {
      state.counts.metadataLoads += Math.ceil(mints.length / 100);
      const tokens = await readJupiterStockMetadataByMint(mints);
      if (tokens.length === 0) throw Error('Jupiter returned no exact-mint token metadata.');
      snapshot.records = selectTopIssuerRecords(mergeJupiterStockMetadata(allRecords, tokens), MARKET_LIMIT);
      snapshot.jupiterTokens = 'ready';
      snapshot.rankingCandidates = undefined;
      if (tokens.length < mints.length) snapshot.issues.push(`${mints.length - tokens.length} snapshot mints lack Jupiter token metadata.`);
    } catch (error) {
      snapshot.issues.push(safeMessage(error, 'Jupiter snapshot token metadata'));
      try {
        const selectedMints = snapshot.records.map(record => record.mint);
        state.counts.solanaMintLoads += Math.ceil(selectedMints.length / 100);
        snapshot.records = mergeSolanaMintMetadata(snapshot.records, await readSolanaMintMetadata(selectedMints));
        snapshot.jupiterTokens = 'fallback';
      } catch {
        snapshot.issues.push('Solana mint-account verification is temporarily unavailable.');
      }
    } finally {
      snapshot.issues = [...new Set(snapshot.issues)].slice(0, 20);
      if (state.universe.peek() === snapshot) updateWorkerUniverse(snapshot.records);
      state.metadataInflight = null;
    }
  })();
}

export function buildPriceCycleBatches(mints: string[], priority: string[] = []) {
  const allowed = new Set(mints);
  const prioritized = [...new Set(priority)].filter(mint => allowed.has(mint));
  const prioritizedSet = new Set(prioritized);
  return [...splitPriceBatches(prioritized), ...splitPriceBatches(mints.filter(mint => !prioritizedSet.has(mint)))];
}

export function priceWorkerBackoffMs(failures: number, retryAfter: number | null, random = Math.random()) {
  const base = retryAfter === null
    ? Math.min(60_000, 2_000 * (2 ** Math.max(0, failures - 1)))
    : Math.max(2_100, retryAfter * 1_000);
  return base + Math.floor(Math.max(0, Math.min(1, random)) * 500);
}

function schedulePriceWorker(delayMs: number) {
  if (!state.worker.started || state.worker.running || state.worker.timer) return;
  state.worker.nextRunAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    state.worker.timer = null;
    state.worker.nextRunAt = null;
    void runPriceWorker();
  }, delayMs);
  timer.unref?.();
  state.worker.timer = timer;
}

function updateWorkerUniverse(records: StockMarketRecord[]) {
  const mints = records.map(record => record.mint).slice(0, MARKET_LIMIT);
  const signature = mints.join(',');
  if (signature === state.worker.signature) return;
  const allowed = new Set(mints);
  state.worker.mints = mints;
  state.worker.signature = signature;
  state.worker.priority = state.worker.priority.filter(mint => allowed.has(mint));
  state.worker.cycleBatches = [];
  state.worker.nextBatchIndex = 0;
  for (const mint of state.worker.prices.keys()) if (!allowed.has(mint)) state.worker.prices.delete(mint);
  for (const mint of state.worker.failures.keys()) if (!allowed.has(mint)) state.worker.failures.delete(mint);
}

function ensurePriceWorker(records: StockMarketRecord[]) {
  updateWorkerUniverse(records);
  if (!state.worker.started) {
    state.worker.started = true;
    schedulePriceWorker(0);
  }
}

export function mayWakePriceWorker(lastCycleStartedAt: number | null, backoffUntil: number | null, now = Date.now()) {
  return (lastCycleStartedAt === null || now - lastCycleStartedAt >= PRICE_CYCLE_MS)
    && (backoffUntil === null || now >= backoffUntil);
}

export function advancePriceBatchCursor(index: number, succeeded: boolean) {
  return succeeded ? index + 1 : index;
}

function prioritizePrices(mints: string[]) {
  const allowed = new Set(state.worker.mints);
  state.worker.priority = [...new Set([...state.worker.priority, ...mints.filter(mint => allowed.has(mint))])].slice(0, MARKET_LIMIT);
  if (mayWakePriceWorker(state.worker.lastCycleStartedAt, state.worker.backoffUntil) && !state.worker.running && state.worker.timer) {
    clearTimeout(state.worker.timer);
    state.worker.timer = null;
    schedulePriceWorker(0);
  }
}

async function runPriceWorker() {
  if (!state.worker.started || state.worker.running || !state.worker.mints.length) return;
  state.worker.running = true;
  if (state.worker.cycleBatches.length === 0) {
    state.worker.lastCycleStartedAt = Date.now();
    state.counts.priceCycles++;
    state.worker.cycleBatches = buildPriceCycleBatches(state.worker.mints, state.worker.priority.splice(0));
    state.worker.nextBatchIndex = 0;
  }
  const cycleStartedAt = state.worker.lastCycleStartedAt ?? Date.now();
  while (state.worker.nextBatchIndex < state.worker.cycleBatches.length) {
    const batch = state.worker.cycleBatches[state.worker.nextBatchIndex];
    try {
      state.counts.priceLoads++;
      const prices = await readJupiterMarketPrices(batch);
      const stillAllowed = new Set(state.worker.mints);
      const eligibleBatch = batch.filter(mint => stillAllowed.has(mint));
      mergePriceBatchIntoLkg(state.worker.prices, state.worker.failures, eligibleBatch, prices, isMarketResolverV2Enabled());
      if (state.worker.cycleBatches.length === 0) break;
      state.worker.nextBatchIndex = advancePriceBatchCursor(state.worker.nextBatchIndex, true);
      state.worker.lastBatchAt = Date.now();
      state.worker.consecutiveFailures = 0;
      state.worker.backoffUntil = null;
      state.worker.lastIssue = null;
    } catch (error) {
      state.worker.nextBatchIndex = advancePriceBatchCursor(state.worker.nextBatchIndex, false);
      state.counts.priceFailures++;
      state.worker.consecutiveFailures++;
      const retryAfter = error instanceof JupiterApiError && error.kind === 'rate-limited' ? error.retryAfterSeconds : null;
      const backoffMs = priceWorkerBackoffMs(state.worker.consecutiveFailures, retryAfter);
      state.worker.backoffUntil = Date.now() + backoffMs;
      state.worker.lastIssue = safeMessage(error, 'Jupiter Price V3 background refresh');
      if (isMarketResolverV2Enabled()) {
        const at = new Date().toISOString();
        for (const mint of batch) state.worker.failures.set(mint, { kind: 'provider-error', at, message: 'Jupiter batch refresh failed; the prior validated value was retained.' });
      }
      recordMarketEvent({ severity: state.worker.consecutiveFailures >= 3 ? 'ERROR' : 'WARN', provider: 'JUPITER', operation: 'price_worker', status: 'BACKOFF_ACTIVE', errorCode: error instanceof JupiterApiError && error.kind === 'rate-limited' ? 'RATE_LIMIT' : 'UNKNOWN', retryAttempt: state.worker.consecutiveFailures, message: `Price worker entered bounded backoff for ${Math.ceil(backoffMs / 1_000)} seconds.` });
      state.worker.running = false;
      schedulePriceWorker(backoffMs);
      return;
    }
  }
  state.worker.lastCycleCompletedAt = Date.now();
  state.worker.cycleBatches = [];
  state.worker.nextBatchIndex = 0;
  state.worker.running = false;
  schedulePriceWorker(Math.max(0, PRICE_CYCLE_MS - (Date.now() - cycleStartedAt)));
}

function priceWorkerSnapshot(now = Date.now()) {
  const status = state.worker.backoffUntil && state.worker.backoffUntil > now
    ? 'backoff' as const
    : state.worker.running
      ? (state.worker.lastCycleCompletedAt === null ? 'warming' as const : 'refreshing' as const)
      : state.worker.started ? 'idle' as const : 'idle' as const;
  return {
    status,
    cached: state.worker.prices.size,
    target: state.worker.mints.length,
    batchSize: PRICE_BATCH_SIZE as 50,
    cycleSeconds: PRICE_CYCLE_MS / 1_000,
    lastBatchAt: state.worker.lastBatchAt === null ? null : new Date(state.worker.lastBatchAt).toISOString(),
    lastCycleCompletedAt: state.worker.lastCycleCompletedAt === null ? null : new Date(state.worker.lastCycleCompletedAt).toISOString(),
    nextRunAt: state.worker.nextRunAt === null ? null : new Date(state.worker.nextRunAt).toISOString(),
  };
}

function activationAt(value: number | string | null) {
  if (value === null || value === 0) return null;
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(value < 1_000_000_000_000 ? value * 1000 : value).toISOString();
}

export function normalizeIssuerMultiplier(input: Awaited<ReturnType<typeof readXstockMultiplier>>, now = Date.now()) {
  const current = input.currentMultiplier === null ? null : decimal(String(input.currentMultiplier)).toFixed();
  const pending = input.newMultiplier && input.newMultiplier > 0 ? decimal(String(input.newMultiplier)).toFixed() : null;
  const activates = activationAt(input.activationDateTime);
  const transitionUnresolved = pending !== null && (activates === null || Date.parse(activates) > now || current !== pending);
  return {
    status: current === null ? 'unavailable' as const : transitionUnresolved ? 'pending' as const : 'current' as const,
    current,
    pending: transitionUnresolved ? pending : null,
    activationAt: transitionUnresolved ? activates : null,
    reason: transitionUnresolved ? input.reason : null,
  };
}

export function lendForRecord(record: StockMarketRecord, vaults: JupiterLendVault[] | null, observedAt: string | null) {
  const sourceUrl = 'https://developers.jup.ag/docs/lend/borrow/api';
  if (vaults === null) return { status: 'unavailable' as const, vaults: [], observedAt: null, sourceUrl };
  const exact = vaults.filter(vault => vault.supplyToken.address === record.mint).slice(0, 12).map(vault => ({
    vaultId: vault.id,
    borrowMint: vault.borrowToken.address,
    borrowSymbol: vault.borrowToken.symbol,
    maxBorrowLtv: decimal(vault.collateralFactor).div(1000).toFixed(),
    liquidationThreshold: decimal(vault.liquidationThreshold).div(1000).toFixed(),
  }));
  return { status: exact.length ? 'available' as const : 'not-found' as const, vaults: exact, observedAt, sourceUrl };
}

async function mapBounded<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function readIssuerIntelligence(record: StockMarketRecord, now = Date.now()) {
  if (!record.issuerVerified || !record.issuerSymbol || !record.intelligence) return record;
  const symbol = record.issuerSymbol;
  const [priceRead, multiplierRead] = await Promise.allSettled([
    state.issuerPrices.read(symbol, async () => { state.counts.issuerPriceLoads++; return readXstockPrice(symbol); }, now),
    state.multipliers.read(symbol, async () => { state.counts.multiplierLoads++; return readXstockMultiplier(symbol); }, now),
  ]);
  const quote = priceRead.status === 'fulfilled' && priceRead.value.value.quote !== null
    ? decimal(String(priceRead.value.value.quote)).toFixed() : null;
  const quoteRetrievedAt = priceRead.status === 'fulfilled' ? priceRead.value.value.retrievedAt : null;
  const multiplier = multiplierRead.status === 'fulfilled'
    ? normalizeIssuerMultiplier(multiplierRead.value.value, now)
    : { status: 'unavailable' as const, current: null, pending: null, activationAt: null, reason: null };
  const premiumDiscount = estimatePremiumDiscount({
    record,
    issuerMint: record.mint,
    issuerPriceUsd: quote,
    issuerCurrency: record.intelligence.market.currency,
    issuerPriceRetrievedAt: quoteRetrievedAt,
    jupiterPriceVerified: record.priceSource === 'jupiter-price-v3' && record.marketObservation?.eligibleForSensitiveUse === true,
    multiplier,
    tradingHalted: record.intelligence.market.tradingHalted,
    sameDisplayShareUnit: record.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' && record.decimals !== null,
    now,
  });
  if (premiumDiscount.status === 'available' && premiumDiscount.valuePct !== null && decimal(premiumDiscount.valuePct).abs().gte(10)) {
    recordMarketEvent({ severity: 'WARN', provider: 'XSTOCKS', operation: 'issuer_price', status: 'PRICE_DIVERGENCE', errorCode: 'PRICE_DIVERGENCE', assetOrMint: record.mint, message: 'Estimated issuer/onchain price difference exceeded ten percent.' });
  }
  return StockMarketRecordSchema.parse({
    ...record,
    intelligence: {
      ...record.intelligence,
      issuerIndicativePriceUsd: quote,
      issuerPriceRetrievedAt: quoteRetrievedAt,
      multiplier,
      premiumDiscount,
    },
  });
}

async function readLendSnapshot(now = Date.now()) {
  try {
    const read = await state.lendVaults.read(async () => {
      state.counts.lendLoads++;
      return { vaults: await readJupiterLendVaults(), retrievedAt: new Date().toISOString() };
    }, now);
    return { vaults: read.value.vaults, observedAt: read.value.retrievedAt, state: read.state, issue: null };
  } catch (error) {
    return { vaults: null, observedAt: null, state: 'unavailable' as const, issue: safeMessage(error, 'Jupiter Lend vault list') };
  }
}

async function readMeteoraEvidence(record: StockMarketRecord, now = Date.now()): Promise<{ pool: PoolObservation | null; issues: string[] }> {
  if (!isMeteoraMarketEnabled()) return { pool: null, issues: [] };
  const minimumLiquidity = minimumMeteoraLiquidityUsd();
  let indexRead: CacheRead<MeteoraPoolIndex>;
  try {
    indexRead = await state.meteoraIndex.read(async () => {
      state.counts.meteoraIndexLoads++;
      return readMeteoraPoolIndexes(state.worker.mints.length ? state.worker.mints : [record.mint], minimumLiquidity);
    }, now);
  } catch {
    return { pool: null, issues: ['Meteora pool index is temporarily unavailable; Jupiter remains selected independently.'] };
  }
  const indexed = selectMeteoraPool(record, indexRead.value.pools, indexRead.value.retrievedAt);
  if (!indexed) return { pool: null, issues: indexRead.value.issues };
  const protocol: MeteoraProtocol = indexed.source === 'meteora-dlmm' ? 'dlmm' : 'damm-v2';
  try {
    const detailRead = await state.meteoraPools.read(`${protocol}:${indexed.poolAddress}`, async () => {
      state.counts.meteoraDetailLoads++;
      return { pool: await readMeteoraPoolDetail(protocol, indexed.poolAddress), protocol, retrievedAt: new Date().toISOString() };
    }, now);
    return {
      pool: selectMeteoraPool(record, [{ protocol: detailRead.value.protocol, pool: detailRead.value.pool }], detailRead.value.retrievedAt) ?? indexed,
      issues: indexRead.value.issues,
    };
  } catch {
    return { pool: indexed, issues: [...indexRead.value.issues, 'Meteora pool detail refresh failed; the validated central index observation is shown.'] };
  }
}

export function trackComparisonTransition(mint: string, comparison: MarketSourceComparison) {
  const prior = state.comparisonStates.get(mint) ?? { status: 'NOT_COMPARABLE' as const, divergedCount: 0, agreedCount: 0 };
  if (comparison.status === 'DIVERGED') {
    const next = { status: prior.status, divergedCount: prior.divergedCount + 1, agreedCount: 0 };
    if (prior.status !== 'DIVERGED' && next.divergedCount >= 2) {
      next.status = 'DIVERGED';
      recordMarketEvent({ severity: 'WARN', provider: 'METEORA', operation: 'source_comparison', status: 'PRICE_DIVERGENCE', errorCode: 'PRICE_DIVERGENCE', assetOrMint: mint, message: 'Jupiter and verified Meteora prices diverged beyond the configured threshold for two observations.' }, false);
    }
    state.comparisonStates.set(mint, next);
    return;
  }
  if (comparison.status === 'AGREE') {
    const next = { status: prior.status, divergedCount: 0, agreedCount: prior.agreedCount + 1 };
    if (prior.status === 'DIVERGED' && next.agreedCount >= 2) {
      next.status = 'AGREE';
      recordMarketEvent({ severity: 'INFO', provider: 'METEORA', operation: 'source_comparison', status: 'RECOVERED', errorCode: null, assetOrMint: mint, message: 'Jupiter and verified Meteora prices returned within the configured recovery gate.' }, false);
    } else if (prior.status !== 'DIVERGED') next.status = 'AGREE';
    state.comparisonStates.set(mint, next);
    return;
  }
  state.comparisonStates.set(mint, { ...prior, divergedCount: 0, agreedCount: 0 });
}

function marketEvidenceFor(record: StockMarketRecord, pool: PoolObservation | null, now = Date.now()) {
  const observation = record.marketObservation ?? projectJupiterObservation({
    mint: record.mint, priceUsd: record.priceUsd, priceChange24hPct: record.priceChange24hPct,
    blockId: null, decimals: record.decimals, retrievedAt: record.priceUpdatedAt,
  }, now);
  const comparison = compareMarketSources({
    enabled: isMeteoraMarketEnabled(), jupiter: observation, meteora: pool,
    exactMint: pool?.stockMint === record.mint,
    sameCurrency: pool?.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    sameDisplayUnit: record.tokenProgram === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' && record.decimals !== null,
    multiplierResolved: record.intelligence?.multiplier.status === 'current' && record.intelligence.multiplier.current !== null,
    quoteConversionVerified: pool?.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    orientationResolved: pool !== null,
    minimumLiquidityUsd: minimumMeteoraLiquidityUsd(), now,
  });
  trackComparisonTransition(record.mint, comparison);
  return MarketEvidenceSchema.parse({
    selectedSource: observation.priceUsd === null ? 'none' : 'jupiter-price-v3',
    selectedFreshness: observation.freshness,
    lastSuccessfulMarketUpdate: observation.retrievedAt,
    meteoraPool: pool,
    comparison,
    meteoraFallbackActive: false,
  });
}

async function enrichSelectedRecords(records: StockMarketRecord[], now = Date.now()) {
  const bounded = boundedIntelligenceRecords(records);
  const [issuerRecords, lend] = await Promise.all([
    mapBounded(bounded, 3, record => readIssuerIntelligence(record, now)),
    readLendSnapshot(now),
  ]);
  const byMint = new Map(issuerRecords.map(record => [record.mint, record]));
  return {
    records: records.map(record => {
      const enriched = byMint.get(record.mint) || record;
      if (!enriched.intelligence) return enriched;
      return StockMarketRecordSchema.parse({ ...enriched, intelligence: { ...enriched.intelligence, lend: lendForRecord(enriched, lend.vaults, lend.observedAt) } });
    }),
    issuerReady: issuerRecords.filter(record => record.intelligence?.issuerPriceRetrievedAt !== null).length,
    lend,
  };
}

async function readPageEnrichmentWithinBudget(records: StockMarketRecord[]) {
  const pending = enrichSelectedRecords(records);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const budget = new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 4_000); });
  const result = await Promise.race([pending, budget]);
  if (timeout) clearTimeout(timeout);
  // The shared keyed caches continue filling. The next ordinary page poll picks
  // up completed intelligence without starting duplicate upstream requests.
  return result ? { ...result, warming: false } : {
    records,
    issuerReady: 0,
    lend: { vaults: null, observedAt: null, state: 'unavailable' as const, issue: null },
    warming: true,
  };
}

export function boundedIntelligenceRecords(records: StockMarketRecord[]) {
  return records.slice(0, VISIBLE_INTELLIGENCE_LIMIT);
}

export async function readStockMarketPage(query: StockMarketQuery, signal?: AbortSignal): Promise<{ page: StockMarketPage; retryAfterSeconds: number | null }> {
  if (signal?.aborted) throw new JupiterApiError('aborted', null, 'Market request was cancelled.');
  seedCatalog();
  const universeRead = await state.universe.read(() => Promise.resolve(issuerSnapshotUniverse()));
  ensureCatalogRefresh();
  if (universeRead.value.jupiterTokens !== 'ready' && (state.catalogFailures > 0 || universeRead.value.xstocks === 'ready')) ensureSnapshotMetadata(universeRead.value);
  ensurePriceWorker(universeRead.value.records);
  const enrichedUniverse = resolvedMarketRecords(universeRead.value.records);
  const selected = selectStockMarketPage(enrichedUniverse, query);
  const intelligence = await readPageEnrichmentWithinBudget(selected.records);
  const summary = summarizeStockMarket(enrichedUniverse);
  const now = Date.now();
  const worker = priceWorkerSnapshot(now);
  const priceIsStale = state.worker.lastBatchAt !== null && now - state.worker.lastBatchAt > 2 * 60_000;
  if (priceIsStale) recordMarketEvent({ severity: 'WARN', provider: 'JUPITER', operation: 'price_worker', status: 'STALE_DATA', errorCode: 'STALE', message: 'Cached market prices exceeded the two-minute freshness threshold.' });
  const priceState: StockMarketPage['cache']['visiblePrices'] = state.worker.prices.size
    ? priceIsStale ? 'stale' : 'hit'
    : state.worker.running ? 'miss' : 'unavailable';
  const priceProvider: StockMarketPage['providers']['jupiterPrice'] = state.worker.backoffUntil && state.worker.backoffUntil > now
    ? 'rate-limited'
    : summary.priceV3Available === enrichedUniverse.length ? 'ready'
      : (summary.priceV3Available ?? 0) > 0 || state.worker.running ? 'partial' : 'unavailable';
  const retryAfter = state.worker.backoffUntil && state.worker.backoffUntil > now ? Math.ceil((state.worker.backoffUntil - now) / 1_000) : null;
  const issues = [...universeRead.value.issues];
  if (intelligence.lend.issue) issues.push(intelligence.lend.issue);
  if (state.worker.lastIssue) issues.push(state.worker.lastIssue);
  if ((summary.priceV3Available ?? 0) < enrichedUniverse.length) issues.push(`${enrichedUniverse.length - (summary.priceV3Available ?? 0)} issuer Price V3 observation${enrichedUniverse.length - (summary.priceV3Available ?? 0) === 1 ? ' is' : 's are'} currently unavailable; separately labeled Tokens V2 reference quotes may still be shown for display only.`);
  if (isMarketResolverV2Enabled()) {
    const delayed = enrichedUniverse.filter(record => record.marketObservation?.freshness === 'DELAYED').length;
    const staleCount = enrichedUniverse.filter(record => record.marketObservation?.freshness === 'STALE').length;
    if (delayed) issues.push(`${delayed} Jupiter last-known-good price${delayed === 1 ? ' is' : 's are'} delayed with original timestamps preserved.`);
    if (staleCount) issues.push(`${staleCount} Jupiter last-known-good price${staleCount === 1 ? ' is' : 's are'} stale and display-only.`);
  }
  const stale = universeRead.state === 'stale' || priceIsStale;
  const incomplete = universeRead.value.xstocks === 'unavailable' || universeRead.value.jupiterTokens !== 'ready' || state.worker.lastIssue !== null
    || intelligence.issuerReady < Math.min(VISIBLE_INTELLIGENCE_LIMIT, selected.records.length) || intelligence.lend.state === 'unavailable';
  const page = StockMarketPageSchema.parse({
    status: stale ? 'stale' : retryAfter !== null ? 'rate-limited' : incomplete ? 'partial' : 'ready',
    records: intelligence.records,
    pagination: { page: selected.page, pageSize: query.pageSize, total: selected.total, totalPages: selected.totalPages },
    summary,
    providers: {
      xstocks: universeRead.state === 'stale' && universeRead.value.xstocks === 'ready' ? 'stale' : universeRead.value.xstocks,
      jupiterTokens: universeRead.state === 'stale' && universeRead.value.jupiterTokens === 'ready' ? 'stale' : universeRead.value.jupiterTokens,
      jupiterPrice: priceProvider,
      xstocksIntelligence: intelligence.warming ? 'warming' : intelligence.issuerReady === Math.min(VISIBLE_INTELLIGENCE_LIMIT, selected.records.length) ? 'ready' : intelligence.issuerReady > 0 ? 'partial' : 'unavailable',
      jupiterLend: intelligence.lend.state === 'unavailable' ? 'unavailable' : intelligence.lend.state === 'stale' ? 'stale' : 'ready',
    },
    cache: { universe: universeRead.state, visiblePrices: priceState, universeExpiresAt: new Date(universeRead.expiresAt).toISOString(), priceWorker: worker },
    updatedAt: state.worker.lastBatchAt === null ? universeRead.value.updatedAt : new Date(state.worker.lastBatchAt).toISOString(),
    issues: [...new Set(issues)].slice(0, 20),
  });
  return { page, retryAfterSeconds: retryAfter };
}

export async function readStockMarketDetail(mint: string) {
  const now = Date.now();
  seedCatalog();
  const universeRead = await state.universe.read(() => Promise.resolve(issuerSnapshotUniverse()));
  ensureCatalogRefresh();
  if (universeRead.value.jupiterTokens !== 'ready' && (state.catalogFailures > 0 || universeRead.value.xstocks === 'ready')) ensureSnapshotMetadata(universeRead.value);
  ensurePriceWorker(universeRead.value.records);
  prioritizePrices([mint]);
  const core = resolvedMarketRecords(universeRead.value.records, now).find(record => record.mint === mint);
  if (!core) return null;
  state.counts.detailLoads++;
  const [issuer, lend, supplyRead, reserveRead, meteora] = await Promise.all([
    readIssuerIntelligence(core, now),
    readLendSnapshot(now),
    core.issuerSymbol ? state.supplies.read(core.issuerSymbol, async () => readXstockSupply(core.issuerSymbol!), now).catch(() => null) : null,
    core.issuerSymbol ? state.reserves.read(core.issuerSymbol, async () => readXstockReserve(core.issuerSymbol!), now).catch(() => null) : null,
    readMeteoraEvidence(core, now),
  ]);
  const record = issuer.intelligence ? StockMarketRecordSchema.parse({
    ...issuer,
    intelligence: {
      ...issuer.intelligence,
      lend: lendForRecord(issuer, lend.vaults, lend.observedAt),
      supply: supplyRead ? { ...supplyRead.value, scope: 'all-xstocks-chain-deployments', retrievedAt: supplyRead.value.retrievedAt } : null,
      reserve: reserveRead ? {
        status: 'available', timestamp: reserveRead.value.timestamp,
        sharesHeld: reserveRead.value.sharesHeld, circulatingSupply: reserveRead.value.circulatingSupply,
        holdings: reserveRead.value.holdings, retrievedAt: reserveRead.value.retrievedAt,
        sourceUrl: `https://api.xstocks.fi/api/v2/public/proof-of-reserves/${encodeURIComponent(core.issuerSymbol!)}`,
      } : null,
    },
  }) : issuer;
  const issues: string[] = [];
  if (!supplyRead) issues.push('Issuer supply details are unavailable.');
  if (!reserveRead) issues.push('Issuer proof-of-reserve details are unavailable.');
  if (lend.vaults === null) issues.push('Jupiter Lend vault availability is unavailable.');
  issues.push(...meteora.issues);
  const marketEvidence = marketEvidenceFor(record, meteora.pool, now);
  return StockMarketDetailSchema.parse({ status: universeRead.state === 'stale' ? 'stale' : issues.length ? 'partial' : 'ready', record, marketEvidence, issues: [...new Set(issues)].slice(0, 12) });
}

export function getStockMarketCacheStats() { return { ...state.counts, priceKeys: state.worker.prices.size, issuerPriceKeys: state.issuerPrices.size, multiplierKeys: state.multipliers.size, supplyKeys: state.supplies.size, reserveKeys: state.reserves.size, meteoraPoolKeys: state.meteoraPools.size, worker: priceWorkerSnapshot() }; }
export function resetStockMarketCacheForTests() {
  if (state.worker.timer) clearTimeout(state.worker.timer);
  state.universe.clear();
  state.issuerPrices.clear(); state.multipliers.clear(); state.supplies.clear(); state.reserves.clear(); state.lendVaults.clear(); state.meteoraIndex.clear(); state.meteoraPools.clear(); state.comparisonStates.clear();
  state.worker = freshWorkerState();
  state.catalogSeeded = false;
  state.catalogInflight = null;
  state.catalogNextAttemptAt = 0;
  state.catalogFailures = 0;
  state.metadataInflight = null;
  state.metadataNextAttemptAt = 0;
  state.counts = { universeLoads: 0, metadataLoads: 0, solanaMintLoads: 0, priceLoads: 0, priceCycles: 0, priceFailures: 0, issuerPriceLoads: 0, multiplierLoads: 0, detailLoads: 0, lendLoads: 0, meteoraIndexLoads: 0, meteoraDetailLoads: 0 };
}
