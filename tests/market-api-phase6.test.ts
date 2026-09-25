import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { CanonicalMarketQuerySchema, projectCanonicalDetail, projectCanonicalMarket } from '@/domain/market-api-v2';
import { DisplayTokenPriceSchema, resolveDisplayTokenPrice } from '@/domain/market-price-policy';
import { type CatalogVersion } from '@/domain/market-snapshot';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { readMarketSnapshot } from '@/services/market-snapshot-reader';
import { MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';
import { bundledMarketV2Catalog, priceTargetMints, refreshMarketV2Catalog, runMarketV2Once } from '@/services/market-v2-engine';

const baseTime = Date.parse('2026-09-25T00:00:00.000Z');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function mint(index: number) {
  let value = index + 1;
  let encoded = '';
  for (let position = 0; position < 5; position++) {
    encoded = alphabet[value % 58] + encoded;
    value = Math.floor(value / 58);
  }
  return 'A'.repeat(39) + encoded;
}
function catalog(size: number): CatalogVersion {
  const at = new Date(baseTime).toISOString();
  const records = normalizeStockUniverse(Array.from({ length: size }, (_, index) => ({
    name: `Issuer ${index} xStock`, symbol: `STK${index}x`,
    underlying: { symbol: `STK${index}`, isin: `US${String(index).padStart(9, '0')}1`,
      type: index % 10 === 0 ? 'ETF' : 'Equity', listingCountry: 'US' },
    deployments: [{ address: mint(index), network: 'Solana' }],
  })), [], at);
  const candidates = records.map(record => ({ variant: adaptLegacyXstockRecord(record).variant, supply: null }));
  const registry = buildUniverseRegistry({ reviewed: [], now: at, reads: [{ provider: 'xstocks', status: 'ready',
    records: candidates, lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
  return { id: `catalog-${size}`, registry, publishedAt: at };
}
function query(overrides: Record<string, unknown> = {}) {
  return CanonicalMarketQuerySchema.parse(overrides);
}

describe('Phase 6 dynamic prices and versioned canonical API', () => {
  it('schedules the bundled exact-issuer fallback as 19 serial batches, without treating unknown classes as equities', async () => {
    const bundled = bundledMarketV2Catalog();
    expect(bundled.registry.entries).toHaveLength(921);
    expect(priceTargetMints(bundled)).toHaveLength(921);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    const calls: Array<{ at: number; count: number }> = [];
    const result = await runMarketV2Once({ catalog: bundled, store, now: () => clock,
      wait: async milliseconds => { clock += milliseconds; },
      readBatch: async mints => {
        calls.push({ at: clock, count: mints.length });
        return { status: 'ok', observations: [] };
      } });
    expect(result).toMatchObject({ status: 'published', batchCalls: 19 });
    expect(calls).toHaveLength(19);
    expect(calls.slice(0, -1).every(call => call.count === 50)).toBe(true);
    expect(calls[18].count).toBe(21);
    expect(calls.every((call, index) => index === 0 || call.at - calls[index - 1].at >= 2100)).toBe(true);
    const read = await readMarketSnapshot({ store, bundledCatalog: bundled, nowMs: clock });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: clock });
    expect(page.summary).toMatchObject({ exactMintCount: 921, priceTargetMintCount: 921,
      priceAttemptedMintCount: 921, priceReturnedMintCount: 0, displayPriceUnavailableMintCount: 921 });
    expect(page.summary.unclassifiedMintCount).toBeGreaterThan(900);
    expect(page.summary.unresolvedMintCount).toBeGreaterThan(900);
    expect(page.summary.delistedMintCount).toBe(0);
    expect(page.pagination.total).toBe(921);
  }, 30_000);

  it('completes 1,050 verified mints in 21 sequential <=50 batches without a top-300 cut', async () => {
    const issuer = catalog(1050);
    expect(issuer.registry.entries).toHaveLength(1050);
    expect(priceTargetMints(issuer)).toHaveLength(1050);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    let active = 0;
    const calls: Array<{ at: number; mints: string[] }> = [];
    const result = await runMarketV2Once({ catalog: issuer, store, now: () => clock,
      wait: async milliseconds => { clock += milliseconds; },
      readBatch: async mints => {
        active++;
        expect(active).toBe(1);
        calls.push({ at: clock, mints });
        active--;
        return { status: 'ok', observations: mints.map(address => ({ mint: address,
          provider: 'jupiter-price-v3', price: '10', currency: 'USD',
          unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
          providerObservedAt: null, retrievedAt: new Date(clock).toISOString() })) };
      } });
    expect(result).toMatchObject({ status: 'published', batchCalls: 21 });
    expect(calls).toHaveLength(21);
    expect(calls.every(call => call.mints.length === 50)).toBe(true);
    expect(calls.every((call, index) => index === 0 || call.at - calls[index - 1].at >= 2_100)).toBe(true);
    const current = (await store.readCurrent())!;
    expect(current.prices).toMatchObject({ totalBatches: 21, processedBatches: 21,
      successfulCount: 1050, missingCount: 0, failedCount: 0, durationMs: 42_000 });
    expect(current.capCoverage?.summary).toMatchObject({ status: 'unavailable', valueUsd: null,
      verifiedMintCount: 1050, eligibleMintCount: 0, coveragePct: '0' });
    const read = await readMarketSnapshot({ store, bundledCatalog: null, nowMs: clock });
    const first = projectCanonicalMarket({ read, query: query({ pageSize: 50 }), nowMs: clock });
    expect(first).toMatchObject({ version: 2, source: 'current', summary: {
      canonicalCount: 1050, verifiedUnderlyingCount: 1050, issuerConfirmedUnderlyingCount: 1050,
      exactMintCount: 1050, issuerConfirmedMintCount: 1050,
      eligibleVerifiedMintCount: 1050, priceAvailableMintCount: 1050,
      coveredSolanaTokenizedCap: { status: 'unavailable', valueUsd: null, verifiedMintCount: 1050 },
    }, pagination: { total: 1050, totalPages: 21, pageSize: 50 } });
    expect(first.records).toHaveLength(50);
    expect(JSON.stringify(first).length).toBeLessThan(75_000);
    const callsBeforeReaders = calls.length;
    await Promise.all(Array.from({ length: 24 }, () => readMarketSnapshot({ store,
      bundledCatalog: null, nowMs: clock })));
    expect(calls).toHaveLength(callsBeforeReaders);
  }, 30_000);

  it('keeps unpriced catalog rows searchable and pages stable after an omitted price', async () => {
    const issuer = catalog(60);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    await runMarketV2Once({ catalog: issuer, store, now: () => clock,
      wait: async milliseconds => { clock += milliseconds; },
      readBatch: async mints => ({ status: 'ok', observations: mints.slice(0, 1).map(address => ({
        mint: address, provider: 'jupiter-price-v3', price: '14', currency: 'USD',
        unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
        providerObservedAt: null, retrievedAt: new Date(clock).toISOString(),
      })) }) });
    const read = await readMarketSnapshot({ store, bundledCatalog: null, nowMs: clock });
    const unpriced = projectCanonicalMarket({ read, query: query({ price: 'unavailable', pageSize: 7,
      page: 3, sort: 'price', direction: 'desc' }), nowMs: clock });
    expect(unpriced.pagination).toMatchObject({ total: 58, page: 3, pageSize: 7, totalPages: 9 });
    expect(unpriced.records).toHaveLength(7);
    expect(unpriced.records.every(row => row.price === null && row.priceUnavailableReason !== null)).toBe(true);
    const pricesFirst = projectCanonicalMarket({ read, query: query({ sort: 'availability', pageSize: 7 }), nowMs: clock });
    expect(pricesFirst.records.slice(0, 2).every(row => row.displayPrice.status !== 'UNAVAILABLE')).toBe(true);
    expect(pricesFirst.records.slice(2).every(row => row.displayPrice.status === 'UNAVAILABLE')).toBe(true);
    const searched = projectCanonicalMarket({ read, query: query({ search: mint(59) }), nowMs: clock });
    expect(searched.pagination.total).toBe(1);
    expect(searched.records[0].id).toBe(`solana:${mint(59)}`);
    const detail = projectCanonicalDetail(read, searched.records[0].id, clock);
    expect(detail?.variants[0].mint).toBe(mint(59));
    expect(detail?.variants[0].tokenPrice).toMatchObject({ status: 'blocked', reason: 'no-token-observation' });
    expect(detail?.selectedPrice).toMatchObject({ status: 'unavailable', reason: 'no-token-observation' });
    expect(detail?.variants[0].variantCap).toMatchObject({ status: 'unavailable', valueUsd: null });
    expect(detail?.variants[0].issuerReference).toMatchObject({ status: 'unavailable', valueUsd: null });
  });

  it('honors 429 Retry-After, one writer lease, and no overlapping cycles', async () => {
    const issuer = catalog(55);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    let calls = 0;
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const first = runMarketV2Once({ catalog: issuer, store, now: () => clock,
      wait: async milliseconds => { clock += milliseconds; },
      readBatch: async mints => {
        calls++;
        if (calls === 1) return { status: 'rate-limited', retryAfterMs: 5_000 };
        if (calls === 2) await gate;
        return { status: 'ok', observations: mints.map(address => ({ mint: address,
          provider: 'jupiter-price-v3', price: '10', currency: 'USD',
          unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
          providerObservedAt: null, retrievedAt: new Date(clock).toISOString() })) };
      } });
    await vi.waitFor(() => expect(calls).toBe(2));
    const rival = await runMarketV2Once({ catalog: issuer, store, now: () => clock,
      readBatch: async () => { throw Error('A rival writer must never call Jupiter.'); } });
    expect(rival).toMatchObject({ status: 'lease-held', batchCalls: 0 });
    unblock();
    expect(await first).toMatchObject({ status: 'published', batchCalls: 3 });
    expect(calls).toBe(3);
    expect((await store.readCurrent())?.prices).toMatchObject({ totalBatches: 2,
      processedBatches: 2, failedCount: 0 });
  });

  it('observes unresolved exact issuer mints, but excludes halted variants while preserving catalog membership', () => {
    const issuer = catalog(3);
    issuer.registry.entries[0].variant.tradingHalted = true;
    issuer.registry.entries[1].variant.eligibility = 'unresolved';
    expect(priceTargetMints(issuer)).toEqual(issuer.registry.entries.slice(1).map(entry => entry.variant.mint).sort());
    expect(issuer.registry.assets).toHaveLength(3);
    expect(CanonicalMarketQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false);
    expect(CanonicalMarketQuerySchema.safeParse({ search: 'x'.repeat(65) }).success).toBe(false);
    expect(CanonicalMarketQuerySchema.safeParse({ page: 1001 }).success).toBe(false);
  });

  it('shows an exact-mint unclassified token price without making it calculation-eligible', async () => {
    const issuer = catalog(1);
    issuer.registry.entries[0].variant.productClass = 'unknown';
    issuer.registry.entries[0].variant.eligibility = 'unresolved';
    issuer.registry.assets[0].productClass = 'unknown';
    const store = new MemoryMarketSnapshotStore();
    expect(priceTargetMints(issuer)).toEqual([issuer.registry.entries[0].variant.mint]);
    const result = await runMarketV2Once({ catalog: issuer, store, now: () => baseTime,
      readBatch: async mints => ({ status: 'ok', observations: mints.map(address => ({
        mint: address, provider: 'jupiter-price-v3', price: '17.25', currency: 'USD',
        unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
        providerObservedAt: null, retrievedAt: new Date(baseTime).toISOString(),
      })) }) });
    expect(result).toMatchObject({ status: 'published', batchCalls: 1 });
    const read = await readMarketSnapshot({ store, bundledCatalog: null, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary).toMatchObject({ canonicalCount: 1, exactMintCount: 1,
      issuerConfirmedMintCount: 1, unclassifiedMintCount: 1, eligibleVerifiedMintCount: 0,
      priceTargetMintCount: 1, priceAttemptedMintCount: 1, priceReturnedMintCount: 1,
      displayPriceLiveMintCount: 1, displayPriceUnderlyingCount: 1,
      priceAvailableMintCount: 0, companyCapUnavailableUnderlyingCount: 1 });
    expect(page.records[0]).toMatchObject({ price: null, displayPrice: {
      status: 'LIVE', priceUsd: '17.25', eligibleForSensitiveUse: false } });
    expect(projectCanonicalMarket({ read, query: query({ price: 'observed' }), nowMs: baseTime })
      .pagination.total).toBe(1);
    expect(projectCanonicalMarket({ read, query: query({ price: 'available' }), nowMs: baseTime })
      .pagination.total).toBe(0);
    expect(projectCanonicalDetail(read, page.records[0].id, baseTime)?.variants[0])
      .toMatchObject({ tokenPrice: { status: 'blocked', reason: 'variant-ineligible' },
        displayPrice: { status: 'LIVE', priceUsd: '17.25' },
        variantCap: { status: 'unavailable', valueUsd: null } });
  });

  it('blocks display when issuer proof, exact mint, unit, currency, or freshness does not pass', () => {
    const variant = catalog(1).registry.entries[0].variant;
    const observation = { mint: variant.mint, provider: 'jupiter-price-v3' as const,
      price: '17.25', currency: 'USD', unit: { kind: 'token-unit' as const, id: `token:${variant.mint}` },
      multiplierVersion: null, providerObservedAt: null, retrievedAt: new Date(baseTime).toISOString() };
    const project = (overrides: Partial<typeof observation> = {}, now = baseTime) =>
      resolveDisplayTokenPrice({ variant, catalogState: 'active', conflicts: 0,
        observation: { ...observation, ...overrides }, now });
    expect(project()).toMatchObject({ status: 'LIVE', priceUsd: '17.25', eligibleForSensitiveUse: false });
    expect(project({ currency: 'EUR' })).toMatchObject({ status: 'UNAVAILABLE', reason: 'currency-mismatch' });
    expect(project({ mint: mint(90) })).toMatchObject({ status: 'UNAVAILABLE', reason: 'invalid-price' });
    expect(project({ unit: { kind: 'token-unit', id: `token:${mint(90)}` } }))
      .toMatchObject({ status: 'UNAVAILABLE', reason: 'unit-mismatch' });
    expect(project({}, baseTime + 130_000)).toMatchObject({ status: 'STALE', priceUsd: '17.25',
      observedAt: new Date(baseTime).toISOString() });
    expect(project({}, baseTime + 601_000)).toMatchObject({ status: 'UNAVAILABLE', reason: 'stale-price' });
    expect(resolveDisplayTokenPrice({ variant, catalogState: 'quarantined', conflicts: 0,
      observation, now: baseTime })).toMatchObject({ status: 'UNAVAILABLE', reason: 'catalog-unconfirmed' });
    expect(resolveDisplayTokenPrice({ variant, catalogState: 'active', conflicts: 1,
      observation, now: baseTime })).toMatchObject({ status: 'UNAVAILABLE', reason: 'identity-conflict' });
    expect(DisplayTokenPriceSchema.safeParse({ ...project(), status: 'UNAVAILABLE' }).success).toBe(false);
  });

  it('keeps all reviewed exact issuer mints searchable without a price worker', async () => {
    const refreshed = await refreshMarketV2Catalog({ previous: null, nowMs: baseTime,
      readIssuer: async () => { throw Error('issuer down'); },
      readTag: async () => { throw Error('tag down'); } });
    const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
      bundledCatalog: refreshed, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary.exactMintCount).toBeGreaterThan(300);
    expect(page.summary.inputCandidateRecordCount).toBeGreaterThan(300);
    expect(page.summary.inputDuplicateRecordCount).toBe(0);
    expect(page.summary.unclassifiedMintCount).toBeGreaterThan(300);
    expect(page.summary.priceTargetMintCount).toBeGreaterThan(300);
    expect(page.summary.priceAttemptedMintCount).toBe(0);
    expect(page.pagination.total).toBeGreaterThan(300);
    expect(page.records).toHaveLength(20);
    expect(page.records.every(row => row.displayPrice.status === 'UNAVAILABLE')).toBe(true);
  });

  it('retains exact-mint last-known-good time after a failed cycle and removes it from stale display eligibility', async () => {
    const issuer = catalog(2);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    await runMarketV2Once({ catalog: issuer, store, now: () => clock,
      readBatch: async mints => ({ status: 'ok', observations: mints.map(address => ({
        mint: address, provider: 'jupiter-price-v3', price: '10', currency: 'USD',
        unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
        providerObservedAt: null, retrievedAt: new Date(clock).toISOString(),
      })) }) });
    const original = (await store.readCurrent())!.prices!.rows[0].observation!.retrievedAt;
    clock += 121_000;
    await runMarketV2Once({ catalog: issuer, store, now: () => clock,
      readBatch: async () => ({ status: 'failed' }) });
    const read = await readMarketSnapshot({ store, bundledCatalog: null, nowMs: clock });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: clock });
    expect(page).toMatchObject({ status: 'degraded', prices: { failedBatchCount: 1,
      failedMintCount: 2, incomplete: true }, summary: { canonicalCount: 2,
      priceAvailableMintCount: 0, priceAvailableUnderlyingCount: 0,
      displayPriceStaleMintCount: 2 } });
    expect(page.records.every(row => row.price === null && row.priceUnavailableReason === 'stale-price')).toBe(true);
    const detail = projectCanonicalDetail(read, page.records[0].id, clock);
    expect(detail?.variants[0].lastObservation).toMatchObject({ priceUsd: '10', retrievedAt: original });
    expect(detail?.variants[0].tokenPrice).toMatchObject({ status: 'blocked', reason: 'stale-price' });
    expect((await store.readCurrent())!.prices!.rows[0]).toMatchObject({ attempt: 'failed',
      retainedLastGood: true, observation: { retrievedAt: original } });
  });

  it('retains LKG across a catalog refresh only when exact-mint economics remain unchanged', async () => {
    const firstCatalog = catalog(2);
    const store = new MemoryMarketSnapshotStore();
    let clock = baseTime;
    await runMarketV2Once({ catalog: firstCatalog, store, now: () => clock,
      readBatch: async mints => ({ status: 'ok', observations: mints.map(address => ({
        mint: address, provider: 'jupiter-price-v3', price: '10', currency: 'USD',
        unit: { kind: 'token-unit', id: `token:${address}` }, multiplierVersion: null,
        providerObservedAt: null, retrievedAt: new Date(clock).toISOString(),
      })) }) });
    const original = (await store.readCurrent())!.prices!.rows[0].observation!.retrievedAt;
    clock += 5_000;
    const refreshed = { ...firstCatalog, id: 'catalog-refreshed' };
    await runMarketV2Once({ catalog: refreshed, store, now: () => clock,
      readBatch: async () => ({ status: 'ok', observations: [] }) });
    expect((await store.readCurrent())!.prices!.rows[0]).toMatchObject({ attempt: 'omitted',
      retainedLastGood: true, observation: { retrievedAt: original } });
    const changed = structuredClone(refreshed);
    changed.id = 'catalog-changed-economics';
    changed.registry.entries[0].variant.decimals = 8;
    clock += 5_000;
    await runMarketV2Once({ catalog: changed, store, now: () => clock,
      readBatch: async () => ({ status: 'ok', observations: [] }) });
    const row = (await store.readCurrent())!.prices!.rows.find(item => item.mint === changed.registry.entries[0].variant.mint)!;
    expect(row).toMatchObject({ attempt: 'omitted', retainedLastGood: false, observation: null });
  });

  it('keeps a reviewed catalog when both optional live discovery providers fail', async () => {
    const refreshed = await refreshMarketV2Catalog({ previous: null, nowMs: baseTime,
      readIssuer: async () => { throw Error('issuer down'); },
      readTag: async () => { throw Error('tag down'); } });
    expect(refreshed.registry.status).toBe('reviewed-fallback');
    expect(refreshed.registry.entries.length).toBeGreaterThan(300);
    expect(priceTargetMints(refreshed).length).toBeGreaterThan(300);
  });

  it('keeps provider-reported token caps partial and company caps independently unavailable', async () => {
    const issuer = catalog(2);
    issuer.registry.entries[0].variant.reportedTokenizedCapUsd = '100.25';
    issuer.registry.entries[1].variant.reportedTokenizedCapUsd = null;
    const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
      bundledCatalog: issuer, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary).toMatchObject({ reportedTokenizedCapUsd: '100.25', reportedCapMintCount: 1,
      coveredSolanaTokenizedCap: { status: 'unavailable', valueUsd: null,
        eligibleMintCount: 0, verifiedMintCount: 2 } });
    expect(page.records.find(row => row.productClass === 'etf')?.companyCap)
      .toMatchObject({ status: 'not-applicable', valueUsd: null });
    expect(page.records.find(row => row.productClass === 'equity')?.companyCap)
      .toMatchObject({ status: 'unavailable', valueUsd: null });
    expect(page.records.every(row => row.variantMints.length === row.variantCount)).toBe(true);
    const detail = projectCanonicalDetail(read, page.records[0].id, baseTime);
    expect(detail?.variants[0].variantCap).toMatchObject({ status: 'unavailable', valueUsd: null });
    expect(detail?.variants[0].issuerReference).toMatchObject({ status: 'unavailable', valueUsd: null });
  });

  it('projects one canonical row for two exact issuer variants and keeps every mint in detail', async () => {
    const at = new Date(baseTime).toISOString();
    const records = normalizeStockUniverse(['A', 'B'].map((suffix, index) => ({
      name: `Shared Company ${suffix} xStock`, symbol: `SHR${suffix}x`,
      underlying: { symbol: 'SHR', isin: 'US1234567890', type: 'Equity', listingCountry: 'US' },
      deployments: [{ address: mint(index), network: 'Solana' }],
    })), [], at);
    const candidates = records.map(record => ({ variant: adaptLegacyXstockRecord(record).variant, supply: null }));
    const unresolved = buildUniverseRegistry({ reviewed: [], now: at,
      reads: [{ provider: 'xstocks', status: 'ready',
        records: candidates,
        lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
    expect(unresolved.assets).toHaveLength(2); // Same ISIN alone does not prove equal economics.
    for (const candidate of candidates) {
      candidate.variant.economicUnit = { kind: 'display-share', unitId: 'US1234567890:share' };
      candidate.variant.multiplier = { status: 'current', current: '1', pending: null, activationAt: null };
    }
    const registry = buildUniverseRegistry({ reviewed: [], now: at,
      reads: [{ provider: 'xstocks', status: 'ready', records: candidates,
        lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
    const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
      bundledCatalog: { id: 'two-variants', registry, publishedAt: at }, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary).toMatchObject({ canonicalCount: 1, verifiedUnderlyingCount: 1,
      issuerConfirmedUnderlyingCount: 1, exactMintCount: 2, issuerConfirmedMintCount: 2 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].variantMints).toEqual([mint(0), mint(1)]);
    expect(projectCanonicalMarket({ read, query: query({ search: mint(1), type: 'equity',
      verification: 'issuer-confirmed' }), nowMs: baseTime }).pagination.total).toBe(1);
    const detail = projectCanonicalDetail(read, page.records[0].id, baseTime);
    expect(detail?.variants.map(variant => variant.mint)).toEqual([mint(0), mint(1)]);
    expect(detail?.selectedPrice).toMatchObject({ status: 'unavailable' });
  });

  it('does not shrink the cap denominator to only currently price-eligible mint classes', async () => {
    const issuer = catalog(2);
    issuer.registry.entries[0].variant.eligibility = 'unresolved';
    const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
      bundledCatalog: issuer, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary).toMatchObject({ issuerConfirmedMintCount: 2,
      eligibleVerifiedMintCount: 1, coveredSolanaTokenizedCap: { verifiedMintCount: 2 } });
  });

  it('joins Jupiter liquidity and reported cap only by exact mint without changing issuer identity', async () => {
    const issuer = catalog(2);
    const exact = issuer.registry.entries[0].variant.mint;
    const tag = normalizeStockUniverse([], [{ id: exact, name: 'Different discovery name',
      symbol: 'LOOKALIKE', decimals: 8,
      tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      liquidity: 500, mcap: 1000, stats24h: { buyVolume: 60, sellVolume: 40 } }], new Date(baseTime).toISOString())[0];
    const at = new Date(baseTime).toISOString();
    const merged = buildUniverseRegistry({ reviewed: [], previous: issuer.registry, now: at,
      reads: [{ provider: 'jupiter-stocks-tag', status: 'ready',
        records: [{ variant: adaptLegacyXstockRecord(tag).variant, supply: null }],
        lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
    const entry = merged.entries.find(row => row.variant.mint === exact)!;
    expect(entry.variant).toMatchObject({ issuer: 'xstocks', verification: 'issuer-confirmed',
      reportedLiquidityUsd: '500', reportedVolume24hUsd: '100',
      reportedTokenizedCapUsd: '1000', reportedMarketRetrievedAt: at });
    expect(entry.variant.tokenSymbol).not.toBe('LOOKALIKE');
    const read = await readMarketSnapshot({ store: new MemoryMarketSnapshotStore(),
      bundledCatalog: { id: 'joined-catalog', registry: merged, publishedAt: at }, nowMs: baseTime });
    const page = projectCanonicalMarket({ read, query: query(), nowMs: baseTime });
    expect(page.summary).toMatchObject({ exactMintCount: 2, liquidMintCount: 1,
      reportedVolume24hUsd: '100', reportedVolumeMintCount: 1,
      reportedTokenizedCapUsd: '1000', reportedCapMintCount: 1,
      reportedCapSource: 'jupiter-tokens-v2', reportedCapOldestRetrievedAt: at });
    const refreshed = buildUniverseRegistry({ reviewed: [], previous: merged, now: at,
      reads: [{ provider: 'xstocks', status: 'ready',
        records: [{ variant: issuer.registry.entries[0].variant, supply: null }],
        lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] });
    expect(refreshed.entries.find(row => row.variant.mint === exact)?.variant)
      .toMatchObject({ reportedVolume24hUsd: '100', reportedMarketRetrievedAt: at });
  });
});
