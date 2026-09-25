import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import {
  CompletePriceSnapshotSchema, PublishedMarketSnapshotSchema,
  type CatalogVersion, type PublishedMarketSnapshot,
} from '@/domain/market-snapshot';
import { type VariantTokenObservation } from '@/domain/market-price-policy';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { runMarketPriceCycle, type PriceCycleInput } from '@/services/market-snapshot-coordinator';
import { readMarketSnapshot, readMarketWithRollback } from '@/services/market-snapshot-reader';
import { getProcessMarketSnapshotStore, MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';

const t0 = Date.parse('2026-09-25T00:00:00.000Z');
const at = new Date(t0).toISOString();
const a = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const b = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';

function catalog(): CatalogVersion {
  const records = [a, b].map(mint => normalizeStockUniverse([{
    name: 'Acme xStock', symbol: 'ACMEx',
    underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint, network: 'Solana' }],
  }], [], at)[0]);
  const issuerRows = records.map(record => ({ variant: adaptLegacyXstockRecord(record).variant, supply: null }));
  const registry = buildUniverseRegistry({ reviewed: [], now: at, reads: [{ provider: 'xstocks', status: 'ready',
    records: issuerRows, lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] },
  { provider: 'jupiter-stocks-tag', status: 'ready', records: [], lastSuccess: at,
    lastAttempt: at, retryAfter: null, issues: [] }] });
  return { id: 'catalog-1', registry, publishedAt: at };
}
function observation(mint: string, clock: number, price = '10'): VariantTokenObservation {
  return { mint, provider: 'jupiter-price-v3', price, currency: 'USD',
    unit: { kind: 'token-unit', id: `token:${mint}` }, multiplierVersion: null,
    providerObservedAt: null, retrievedAt: new Date(clock).toISOString() };
}
function setup(store = new MemoryMarketSnapshotStore()) {
  let clock = t0;
  const calls: { at: number; mints: string[] }[] = [];
  const input = (cycleId: string, overrides: Partial<PriceCycleInput> = {}): PriceCycleInput => ({
    store, ownerId: 'writer-A', cycleId, catalog: catalog(), targetMints: [a, b],
    now: () => clock, wait: async ms => { clock += ms; }, batchSize: 1,
    readBatch: async mints => {
      calls.push({ at: clock, mints });
      return { status: 'ok', observations: mints.map(mint => observation(mint, clock)) };
    }, ...overrides,
  });
  return { store, input, calls, get clock() { return clock; }, advance(ms: number) { clock += ms; } };
}

describe('Phase 5 complete snapshots and one writer', () => {
  it('reuses one process-local store instead of creating a lease per caller', () => {
    expect(getProcessMarketSnapshotStore()).toBe(getProcessMarketSnapshotStore());
  });

  it('cold reads only the dated bundled catalog and makes zero provider calls', async () => {
    const env = setup();
    const read = await readMarketSnapshot({ store: env.store, bundledCatalog: catalog(), nowMs: t0 });
    expect(read).toMatchObject({ source: 'bundled', degraded: true,
      snapshot: { prices: null, capCoverage: null } });
    expect(env.calls).toHaveLength(0);
    expect(await env.store.readCurrent()).toBeNull();
  });

  it('keeps an explicit legacy rollback seam and snapshot readers never call a provider', async () => {
    const env = setup();
    let legacyReads = 0;
    const common = { readLegacy: async () => { legacyReads++; return 'approved-legacy-page'; },
      snapshot: { store: env.store, bundledCatalog: catalog(), nowMs: t0 } };
    expect(await readMarketWithRollback({ ...common, mode: 'legacy' }))
      .toMatchObject({ mode: 'legacy', value: 'approved-legacy-page' });
    expect(await readMarketWithRollback({ ...common, mode: 'snapshot' }))
      .toMatchObject({ mode: 'snapshot', value: { source: 'bundled' } });
    expect(legacyReads).toBe(1);
    expect(env.calls).toHaveLength(0);
  });

  it('marks catalog-only current snapshots degraded and rejects future-dated price snapshots', async () => {
    const env = setup();
    const lease = (await env.store.tryAcquireLease('catalog-writer', t0, 30_000))!;
    expect(await env.store.publish({ id: 'catalog-only', catalog: catalog(), prices: null,
      capCoverage: null, publishedAt: at }, null, lease, t0)).toBe(true);
    await env.store.releaseLease(lease);
    expect(await readMarketSnapshot({ store: env.store, bundledCatalog: catalog(), nowMs: t0 }))
      .toMatchObject({ source: 'current', degraded: true, reason: 'no-complete-snapshot',
        snapshot: { prices: null } });
    await runMarketPriceCycle(env.input('cycle-1'));
    expect(await readMarketSnapshot({ store: env.store, bundledCatalog: catalog(), nowMs: t0 - 6_000 }))
      .toMatchObject({ source: 'bundled', degraded: true, snapshot: { prices: null } });
  });

  it('runs one sequential paced queue, publishes all target rows atomically and keeps pieces separate', async () => {
    const env = setup();
    expect(await runMarketPriceCycle(env.input('cycle-1'))).toMatchObject({
      status: 'published', snapshotId: 'cycle-1', batchCalls: 2 });
    expect(env.calls.map(call => call.at)).toEqual([t0, t0 + 2_100]);
    const current = (await env.store.readCurrent())!;
    expect(current.prices).toMatchObject({ targetMints: [a, b], totalBatches: 2,
      processedBatches: 2, successfulCount: 2, missingCount: 0, failedCount: 0 });
    expect(await env.store.readCatalogVersion('catalog-1')).not.toBeNull();
    expect(await env.store.readPriceVersion('cycle-1')).toEqual(current.prices);
    expect(await env.store.readCapCoverageVersion('missing')).toBeNull();
    expect(await env.store.readProgress()).toMatchObject({ state: 'complete', processedBatches: 2 });
    expect(await env.store.readLease()).toBeNull();
    current.prices!.rows[0].attempt = 'failed';
    expect((await env.store.readCurrent())!.prices!.rows[0].attempt).toBe('success');
  });

  it('serves the previous complete version to concurrent readers while another cycle is still building', async () => {
    const env = setup();
    await runMarketPriceCycle(env.input('cycle-1'));
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const second = runMarketPriceCycle(env.input('cycle-2', { readBatch: async mints => {
      await gate;
      return { status: 'ok', observations: mints.map(mint => observation(mint, env.clock)) };
    } }));
    await vi.waitFor(async () => expect((await env.store.readProgress())?.cycleId).toBe('cycle-2'));
    const readers = await Promise.all(Array.from({ length: 12 }, () => readMarketSnapshot({
      store: env.store, bundledCatalog: catalog(), nowMs: env.clock })));
    expect(readers.every(read => read.source === 'current' && read.snapshot?.id === 'cycle-1')).toBe(true);
    expect(await runMarketPriceCycle(env.input('cycle-rival', { ownerId: 'writer-B' })))
      .toMatchObject({ status: 'lease-held', batchCalls: 0 });
    unblock();
    expect((await second).status).toBe('published');
    expect((await env.store.readCurrent())?.id).toBe('cycle-2');
    expect(env.calls).toHaveLength(2); // Reader/rival traffic created no provider calls.
  });

  it('retains original successful timestamps through omissions and failed batches, never zero', async () => {
    const env = setup();
    await runMarketPriceCycle(env.input('cycle-1'));
    const original = (await env.store.readCurrent())!.prices!.rows[0].observation!.retrievedAt;
    await runMarketPriceCycle(env.input('cycle-2', { readBatch: async () => ({ status: 'ok', observations: [] }) }));
    const omitted = (await env.store.readCurrent())!.prices!;
    expect(omitted).toMatchObject({ successfulCount: 0, missingCount: 2, failedCount: 0 });
    expect(omitted.rows[0]).toMatchObject({ attempt: 'omitted', retainedLastGood: true,
      observation: { retrievedAt: original, price: '10' } });
    await runMarketPriceCycle(env.input('cycle-3', { readBatch: async () => { throw Error('provider down'); } }));
    const failed = (await env.store.readCurrent())!.prices!;
    expect(failed).toMatchObject({ successfulCount: 0, missingCount: 0, failedCount: 2 });
    expect(failed.rows[0]).toMatchObject({ attempt: 'failed', retainedLastGood: true,
      observation: { retrievedAt: original } });
  });

  it('honors Retry-After plus global pacing and never sends batches in parallel', async () => {
    const env = setup();
    const attempts: number[] = [];
    const response = await runMarketPriceCycle(env.input('cycle-retry', { readBatch: async mints => {
      attempts.push(env.clock);
      return attempts.length === 1 ? { status: 'rate-limited', retryAfterMs: 5_000 }
        : { status: 'ok', observations: mints.map(mint => observation(mint, env.clock)) };
    } }));
    expect(response).toMatchObject({ status: 'published', batchCalls: 3 });
    expect(attempts).toEqual([t0, t0 + 5_000, t0 + 7_100]);
  });

  it('aborts a slow provider batch before its lease can expire and accounts for failure', async () => {
    const env = setup();
    let aborted = false;
    const result = await runMarketPriceCycle(env.input('cycle-timeout', { targetMints: [a],
      leaseTtlMs: 5_000, requestTimeoutMs: 500,
      readBatch: async (_mints, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true });
      }),
    }));
    expect(aborted).toBe(true);
    expect(result).toMatchObject({ status: 'published', batchCalls: 1 });
    expect((await env.store.readCurrent())?.prices).toMatchObject({
      successfulCount: 0, failedCount: 1, rows: [{ observation: null, attempt: 'failed' }],
    });
  });

  it('fences an expired old writer after a new owner publishes, including crash/restart semantics', async () => {
    const env = setup();
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const old = runMarketPriceCycle(env.input('cycle-old', { readBatch: async mints => {
      await gate;
      return { status: 'ok', observations: mints.map(mint => observation(mint, env.clock)) };
    } }));
    await vi.waitFor(async () => expect((await env.store.readProgress())?.cycleId).toBe('cycle-old'));
    env.advance(31_000);
    const replacement = await runMarketPriceCycle(env.input('cycle-new', { ownerId: 'writer-B' }));
    expect(replacement.status).toBe('published');
    unblock();
    expect((await old).status).toBe('lost-lease');
    expect((await env.store.readCurrent())?.id).toBe('cycle-new');
    expect((await env.store.readLease())?.fencingToken).toBeUndefined();
  });

  it('keeps the previous pointer after rejected publication or invalid incomplete payload', async () => {
    class RejectingStore extends MemoryMarketSnapshotStore {
      reject = false;
      override async publish(...args: Parameters<MemoryMarketSnapshotStore['publish']>) {
        return this.reject ? false : super.publish(...args);
      }
    }
    const store = new RejectingStore();
    const env = setup(store);
    await runMarketPriceCycle(env.input('cycle-1'));
    const current = (await env.store.readCurrent())!;
    store.reject = true;
    expect((await runMarketPriceCycle(env.input('cycle-2'))).status)
      .toBe('publication-rejected');
    expect((await env.store.readCurrent())?.id).toBe('cycle-1');
    expect(CompletePriceSnapshotSchema.safeParse({ ...current.prices!, rows: current.prices!.rows.slice(0, 1) }).success)
      .toBe(false);
    expect(PublishedMarketSnapshotSchema.safeParse({ ...current, prices: {
      ...current.prices!, processedBatches: 1 } }).success).toBe(false);
  });

  it('isolates cap coverage from price publication and stores linked metadata separately', async () => {
    const env = setup();
    const cap = (cycleId: string) => ({ id: `cap-${cycleId}`, catalogId: 'catalog-1', priceId: cycleId,
      calculatedAt: new Date(env.clock).toISOString(),
      summary: { status: 'unavailable' as const, valueUsd: null, eligibleMintCount: 0,
        unavailableMintCount: 2, verifiedMintCount: 2, coveragePct: '0',
        catalogStatus: 'available' as const, oldestInputAt: null,
        excluded: [{ mint: a, reason: 'missing-supply' as const },
          { mint: b, reason: 'missing-supply' as const }] } });
    expect((await runMarketPriceCycle(env.input('cycle-1', {
      deriveCapCoverage: async () => cap('cycle-1'),
    }))).status).toBe('published');
    expect((await env.store.readCurrent())?.capCoverage?.priceId).toBe('cycle-1');
    expect(await env.store.readCapCoverageVersion('cap-cycle-1')).not.toBeNull();
    expect((await runMarketPriceCycle(env.input('cycle-2', {
      deriveCapCoverage: async () => { throw Error('supply provider unavailable'); },
    }))).status).toBe('published');
    expect((await env.store.readCurrent())?.prices?.id).toBe('cycle-2');
    expect((await env.store.readCurrent())?.capCoverage).toBeNull();
    expect((await env.store.readCapCoverageVersion('cap-cycle-1'))?.priceId).toBe('cycle-1');
  });

  it('falls back to the previous validated version when the current pointer is corrupt', async () => {
    const env = setup();
    await runMarketPriceCycle(env.input('cycle-1'));
    await runMarketPriceCycle(env.input('cycle-2'));
    const history = await env.store.readHistory();
    const corrupt = Object.create(env.store) as MemoryMarketSnapshotStore;
    corrupt.readCurrent = async () => ({ id: 'invalid' } as PublishedMarketSnapshot);
    corrupt.readHistory = async () => history.slice(1);
    expect(await readMarketSnapshot({ store: corrupt, bundledCatalog: catalog(), nowMs: env.clock }))
      .toMatchObject({ source: 'previous', degraded: true, reason: 'current-invalid',
        snapshot: { id: 'cycle-1' } });
  });

  it('aborts before publication if fenced progress storage fails mid-cycle', async () => {
    class FailingProgressStore extends MemoryMarketSnapshotStore {
      fail = false;
      override async writeProgress(...args: Parameters<MemoryMarketSnapshotStore['writeProgress']>) {
        return this.fail && args[0].processedBatches > 0 ? false : super.writeProgress(...args);
      }
    }
    const store = new FailingProgressStore();
    const env = setup(store);
    await runMarketPriceCycle(env.input('cycle-1'));
    store.fail = true;
    expect((await runMarketPriceCycle(env.input('cycle-2'))).status).toBe('lost-lease');
    expect((await store.readCurrent())?.id).toBe('cycle-1');
  });

  it('uses bounded local or bundled fallback on store outage and never treats old prices as new', async () => {
    const env = setup();
    await runMarketPriceCycle(env.input('cycle-1'));
    const prior = (await env.store.readCurrent())!;
    const broken = Object.create(env.store) as MemoryMarketSnapshotStore;
    broken.readCurrent = async () => { throw Error('store offline'); };
    broken.tryAcquireLease = async () => { throw Error('store offline'); };
    expect(await readMarketSnapshot({ store: broken, bundledCatalog: catalog(),
      localPrevious: prior, nowMs: env.clock + 3_000 })).toMatchObject({
      source: 'local-previous', degraded: true, reason: 'store-unavailable',
      snapshot: { id: 'cycle-1' } });
    const cold = await readMarketSnapshot({ store: broken, bundledCatalog: catalog(),
      nowMs: env.clock + 3_000 });
    expect(cold).toMatchObject({ source: 'bundled', snapshot: { prices: null } });
    expect((await runMarketPriceCycle(env.input('cycle-offline', { store: broken }))).batchCalls).toBe(0);
    expect(env.calls).toHaveLength(2);
  });

  it('keeps only short rollback history and old immutable snapshots cannot be rewritten', async () => {
    const env = setup(new MemoryMarketSnapshotStore(3));
    for (let index = 1; index <= 4; index++) {
      expect((await runMarketPriceCycle(env.input(`cycle-${index}`))).status).toBe('published');
    }
    expect((await env.store.readHistory()).map(item => item.id)).toEqual(['cycle-4', 'cycle-3', 'cycle-2']);
    expect(await env.store.readPriceVersion('cycle-1')).toBeNull();
    expect(await env.store.readPriceVersion('cycle-4')).not.toBeNull();
  });
});
