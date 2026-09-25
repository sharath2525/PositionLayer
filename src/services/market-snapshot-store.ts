import 'server-only';
import {
  CatalogVersionSchema, CapCoverageVersionSchema, CompletePriceSnapshotSchema,
  MarketCycleProgressSchema, MarketWriterLeaseSchema, PublishedMarketSnapshotSchema,
  type CatalogVersion, type CapCoverageVersion, type CompletePriceSnapshot,
  type MarketCycleProgress, type MarketWriterLease, type PublishedMarketSnapshot,
} from '@/domain/market-snapshot';

/** A shared adapter must make lease and publish operations atomic/CAS. Merely
 * implementing these method names on a non-transactional cache is unsafe. */
export interface MarketSnapshotStore {
  readCurrent(): Promise<PublishedMarketSnapshot | null>;
  readHistory(): Promise<PublishedMarketSnapshot[]>;
  readCatalogVersion(id: string): Promise<CatalogVersion | null>;
  readPriceVersion(id: string): Promise<CompletePriceSnapshot | null>;
  readCapCoverageVersion(id: string): Promise<CapCoverageVersion | null>;
  readProgress(): Promise<MarketCycleProgress | null>;
  readLease(): Promise<MarketWriterLease | null>;
  tryAcquireLease(ownerId: string, nowMs: number, ttlMs: number): Promise<MarketWriterLease | null>;
  renewLease(lease: MarketWriterLease, nowMs: number, ttlMs: number): Promise<MarketWriterLease | null>;
  releaseLease(lease: MarketWriterLease): Promise<void>;
  writeProgress(progress: MarketCycleProgress, lease: MarketWriterLease, nowMs: number): Promise<boolean>;
  publish(snapshot: PublishedMarketSnapshot, expectedCurrentId: string | null,
    lease: MarketWriterLease, nowMs: number): Promise<boolean>;
}

function validClock(nowMs: number, ttlMs?: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
      (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000))) {
    throw new Error('Invalid market snapshot clock or lease duration.');
  }
}
function copy<T>(value: T): T { return structuredClone(value); }

/** Single-process reference implementation. It is not a distributed store. */
export class MemoryMarketSnapshotStore implements MarketSnapshotStore {
  private readonly catalogs = new Map<string, CatalogVersion>();
  private readonly prices = new Map<string, CompletePriceSnapshot>();
  private readonly caps = new Map<string, CapCoverageVersion>();
  private readonly bundles = new Map<string, { catalogId: string; priceId: string | null;
    capId: string | null; publishedAt: string }>();
  private historyIds: string[] = [];
  private currentId: string | null = null;
  private progress: MarketCycleProgress | null = null;
  private lease: MarketWriterLease | null = null;
  private lastFencingToken = 0;

  constructor(private readonly historyLimit = 3) {
    if (!Number.isInteger(historyLimit) || historyLimit < 2 || historyLimit > 5) {
      throw new Error('Snapshot history limit must be between two and five.');
    }
  }

  private assemble(id: string): PublishedMarketSnapshot | null {
    const bundle = this.bundles.get(id);
    if (!bundle) return null;
    const catalog = this.catalogs.get(bundle.catalogId);
    const prices = bundle.priceId ? this.prices.get(bundle.priceId) : null;
    const capCoverage = bundle.capId ? this.caps.get(bundle.capId) : null;
    if (!catalog || (bundle.priceId && !prices) || (bundle.capId && !capCoverage)) return null;
    return PublishedMarketSnapshotSchema.parse(copy({ id, catalog, prices, capCoverage,
      publishedAt: bundle.publishedAt }));
  }

  async readCurrent() { return this.currentId ? this.assemble(this.currentId) : null; }
  async readHistory() { return this.historyIds.flatMap(id => { const item = this.assemble(id); return item ? [item] : []; }); }
  async readCatalogVersion(id: string) { return copy(this.catalogs.get(id) ?? null); }
  async readPriceVersion(id: string) { return copy(this.prices.get(id) ?? null); }
  async readCapCoverageVersion(id: string) { return copy(this.caps.get(id) ?? null); }
  async readProgress() { return copy(this.progress); }
  async readLease() { return copy(this.lease); }

  private owns(lease: MarketWriterLease, nowMs: number) {
    return this.lease !== null && this.lease.ownerId === lease.ownerId
      && this.lease.fencingToken === lease.fencingToken && this.lease.expiresAtMs > nowMs;
  }
  async tryAcquireLease(ownerId: string, nowMs: number, ttlMs: number) {
    validClock(nowMs, ttlMs);
    MarketWriterLeaseSchema.shape.ownerId.parse(ownerId);
    if (this.lease && this.lease.expiresAtMs > nowMs) return null;
    this.lease = MarketWriterLeaseSchema.parse({ ownerId, fencingToken: ++this.lastFencingToken,
      expiresAtMs: nowMs + ttlMs });
    return copy(this.lease);
  }
  async renewLease(lease: MarketWriterLease, nowMs: number, ttlMs: number) {
    validClock(nowMs, ttlMs);
    MarketWriterLeaseSchema.parse(lease);
    if (!this.owns(lease, nowMs)) return null;
    this.lease = { ...this.lease!, expiresAtMs: nowMs + ttlMs };
    return copy(this.lease);
  }
  async releaseLease(lease: MarketWriterLease) {
    MarketWriterLeaseSchema.parse(lease);
    if (this.lease?.ownerId === lease.ownerId && this.lease.fencingToken === lease.fencingToken) this.lease = null;
  }
  async writeProgress(progress: MarketCycleProgress, lease: MarketWriterLease, nowMs: number) {
    validClock(nowMs);
    const valid = MarketCycleProgressSchema.parse(progress);
    if (!this.owns(lease, nowMs) || valid.fencingToken !== lease.fencingToken) return false;
    this.progress = copy(valid);
    return true;
  }

  async publish(snapshot: PublishedMarketSnapshot, expectedCurrentId: string | null,
    lease: MarketWriterLease, nowMs: number) {
    validClock(nowMs);
    const valid = PublishedMarketSnapshotSchema.parse(snapshot);
    if (!this.owns(lease, nowMs) || this.currentId !== expectedCurrentId) return false;
    if (this.bundles.has(valid.id) && this.currentId !== valid.id) return false;
    for (const [map, item] of [[this.catalogs, valid.catalog], [this.prices, valid.prices],
      [this.caps, valid.capCoverage]] as const) {
      if (item && map.has(item.id) && JSON.stringify(map.get(item.id)) !== JSON.stringify(item)) {
        throw new Error('Immutable market snapshot version ID was reused with different contents.');
      }
    }
    // No awaits between immutable writes and the pointer switch. A distributed
    // adapter must perform the equivalent as one fenced transaction.
    this.catalogs.set(valid.catalog.id, copy(CatalogVersionSchema.parse(valid.catalog)));
    if (valid.prices) this.prices.set(valid.prices.id, copy(CompletePriceSnapshotSchema.parse(valid.prices)));
    if (valid.capCoverage) this.caps.set(valid.capCoverage.id, copy(CapCoverageVersionSchema.parse(valid.capCoverage)));
    this.bundles.set(valid.id, { catalogId: valid.catalog.id, priceId: valid.prices?.id ?? null,
      capId: valid.capCoverage?.id ?? null, publishedAt: valid.publishedAt });
    this.currentId = valid.id;
    this.historyIds = [valid.id, ...this.historyIds.filter(id => id !== valid.id)].slice(0, this.historyLimit);
    this.prune();
    return true;
  }

  private prune() {
    const retained = new Set(this.historyIds);
    for (const id of this.bundles.keys()) if (!retained.has(id)) this.bundles.delete(id);
    const catalogIds = new Set([...this.bundles.values()].map(item => item.catalogId));
    const priceIds = new Set([...this.bundles.values()].map(item => item.priceId).filter((id): id is string => id !== null));
    const capIds = new Set([...this.bundles.values()].map(item => item.capId).filter((id): id is string => id !== null));
    for (const id of this.catalogs.keys()) if (!catalogIds.has(id)) this.catalogs.delete(id);
    for (const id of this.prices.keys()) if (!priceIds.has(id)) this.prices.delete(id);
    for (const id of this.caps.keys()) if (!capIds.has(id)) this.caps.delete(id);
  }
}

type SnapshotGlobal = typeof globalThis & { __positionLayerMarketSnapshotStore?: MemoryMarketSnapshotStore };

/** Reuse exactly one memory lease/pointer within a Node process, including
 * module reloads. This does not coordinate separate processes or deployments. */
export function getProcessMarketSnapshotStore(): MemoryMarketSnapshotStore {
  const global = globalThis as SnapshotGlobal;
  global.__positionLayerMarketSnapshotStore ??= new MemoryMarketSnapshotStore();
  return global.__positionLayerMarketSnapshotStore;
}
