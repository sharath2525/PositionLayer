import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import sample from './fixtures/market-phase1/jupiter-public-sample.json';
import { parseMarketEnrichment } from '@/domain/market-enrichment';
import { ageCanonicalPage, ageCanonicalDetail } from '@/domain/market-client-freshness';
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { CanonicalMarketQuerySchema, projectCanonicalMarket, projectCanonicalDetail, topCompanyRows, compareCompanyCaps } from '@/domain/market-api-v2';
import { runMarketPriceCycle, type PriceCycleInput } from '@/services/market-snapshot-coordinator';
import { MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';
import { DurableMarketSnapshotStore, marketWriterAllowed, closeRuntimeMarketSnapshotStore } from '@/services/market-durable-store';
import { readMarketSnapshot } from '@/services/market-snapshot-reader';
import { readStockMarketPage } from '@/services/stocks-market';
import { StockMarketQuerySchema } from '@/domain/stocks';
import { legacySnapshotRecords } from '@/services/market-legacy-reader';
import { readRemoteCanonicalPage } from '@/services/market-v2-remote';

const a = sample.requested[0], b = sample.requested[1];
const t = Date.parse(sample.retrievedAt), at = sample.retrievedAt;
const records = normalizeStockUniverse([a, b].map((mint, index) => ({
  name: `Phase One ${index}`, symbol: `ONE${index}x`,
  underlying: { symbol: `ONE${index}`, isin: `US000000000${index + 1}`, type: 'Equity', listingCountry: 'US' },
  deployments: [{ address: mint, network: 'Solana' }],
})), [], at);
const catalog = { id: 'phase-one-catalog', publishedAt: at, registry: buildUniverseRegistry({
  reviewed: [], now: at, reads: [{ provider: 'xstocks', status: 'ready',
    records: records.map(row => ({ variant: adaptLegacyXstockRecord(row).variant, supply: null })),
    lastSuccess: at, lastAttempt: at, retryAfter: null, issues: [] }] }) };
const observed = { mint: a, provider: 'jupiter-price-v3' as const, price: '12', currency: 'USD',
  unit: { kind: 'token-unit' as const, id: `token:${a}` }, multiplierVersion: null,
  providerObservedAt: null, retrievedAt: at };
function cycle(store: MemoryMarketSnapshotStore, overrides: Partial<PriceCycleInput> = {}): PriceCycleInput {
  return { store, catalog, cycleId: 'phase-one-cycle', ownerId: 'phase-one-writer', targetMints: [a, b],
    now: () => t, readBatch: async () => ({ status: 'ok', observations: [observed],
      enrichments: [parseMarketEnrichment(a, { usdPrice: 12, liquidity: 30, stockData: { price: 11 } }, at)!,
        parseMarketEnrichment(b, { stockData: { price: 5, mcap: 500 } }, at)!] }), ...overrides };
}
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); closeRuntimeMarketSnapshotStore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Stocks upgrade Phase 1 acceptance', () => {
  it('filters cached listing metadata and expires session flags without changing global ticker coverage', async () => {
    const store = new MemoryMarketSnapshotStore();
    const listings = structuredClone(catalog);
    const first = listings.registry.entries.find(entry => entry.variant.mint === a)!;
    const second = listings.registry.entries.find(entry => entry.variant.mint === b)!;
    first.variant.underlying.listingCountry = 'GB';
    first.variant.eligibility = 'excluded';
    first.variant.listing = { currency: 'GBP', exchange: 'LSE', period: 'regular', openNow: true,
      nextChangeAt: new Date(t + 60_000).toISOString() };
    second.variant.listing = { currency: 'USD', exchange: 'NASDAQ', period: 'closed', openNow: false,
      nextChangeAt: new Date(t + 3600_000).toISOString() };
    await runMarketPriceCycle(cycle(store, { catalog: listings }));
    const read = await readMarketSnapshot({ store, nowMs: t, bundledCatalog: listings });
    const all = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({}), nowMs: t });
    const filtered = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ view: 'tokenized',
      country: 'GB', currency: 'GBP', market: 'open' }), nowMs: t });
    expect(filtered.records).toHaveLength(1);
    expect(filtered.records[0]).toMatchObject({ listingCountry: 'GB', listingCurrency: 'GBP', listingExchange: 'LSE', marketStatus: 'open' });
    expect(filtered.facets).toEqual({ countries: ['GB', 'US'], currencies: ['GBP', 'USD'] });
    expect(filtered.ticker).toEqual(all.ticker);
    expect(projectCanonicalMarket({read,query:CanonicalMarketQuerySchema.parse({view:'listed',market:'open'}),nowMs:t}).records).toEqual([]);
    expect(projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ market: 'closed' }), nowMs: t }).records[0].variantMints).toContain(b);
    expect(projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ market: 'open' }), nowMs: t + 61_000 }).records).toEqual([]);
    expect(ageCanonicalPage(filtered, t + 61_000).records[0].marketStatus).toBe('unknown');
    expect(CanonicalMarketQuerySchema.safeParse({ currency: 'INVALID' }).success).toBe(false);
  });

  it('ranks companies by reported cap rather than movement and ages quotes with the table', async () => {
    const store = new MemoryMarketSnapshotStore();
    await runMarketPriceCycle(cycle(store, { readBatch: async () => ({ status: 'ok',
      observations: [observed, { ...observed, mint: b, unit: { kind: 'token-unit', id: `token:${b}` } }],
      enrichments: [parseMarketEnrichment(a, { priceChange24h: 3, stockData: { price: 12, mcap: 1000 } }, at)!,
        parseMarketEnrichment(b, { priceChange24h: -9, stockData: { price: 12, mcap: 500 } }, at)!] }) }));
    const read = await readMarketSnapshot({ store, nowMs: t, bundledCatalog: catalog });
    const page = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({}), nowMs: t });
    expect(page.ticker.map(row => row.change24h?.value)).toEqual([3, -9]);
    const delayed = ageCanonicalPage(page, t + 46_000);
    expect(delayed.ticker.every(row => row.displayPrice.status === 'DELAYED')).toBe(true);
    expect(ageCanonicalPage(page, t + 601_000).ticker).toEqual([]);
    const mixed = structuredClone(page);
    mixed.ticker[0].change24h!.retrievedAt = new Date(t - 601_000).toISOString();
    expect(ageCanonicalPage(mixed, t).ticker[0].change24h).toBeNull();
    expect(ageCanonicalPage(mixed, t).ticker[0].displayPrice.priceUsd).toBe('12');
  });

  it('bounds company ranking, deduplicates underlyings, excludes funds and never mixes currencies', async () => {
    const store = new MemoryMarketSnapshotStore(); await runMarketPriceCycle(cycle(store));
    const read = await readMarketSnapshot({ store, nowMs: t, bundledCatalog: catalog });
    const base = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({}), nowMs: t }).records.find(r=>r.variantMints.includes(a))!;
    const rows = Array.from({length:25},(_,i)=>({...base,id:`rank-${i}`,isin:`test-${i}`,symbol:`TEST${i}`,productClass:'equity' as const,
      listedData:parseMarketEnrichment(a,{stockData:{price:12,mcap:10000-i,currency:'USD'}},at)!}));
    const duplicate={...rows[0],id:'duplicate'};
    const etf={...rows[0],id:'etf',isin:'etf',productClass:'etf' as const};
    const noQuote={...rows[0],id:'no-quote',displayPrice:{...base.displayPrice,priceUsd:null}};
    const missing={...rows[0],id:'missing',listedData:null};
    const foreign={...rows[0],id:'foreign',isin:'foreign',listedData:parseMarketEnrichment(a,{stockData:{price:12,mcap:999999,currency:'HKD'}},at)!};
    const unlabelled={...foreign,id:'unlabelled',isin:'unlabelled',listedData:parseMarketEnrichment(a,{stockData:{price:12,mcap:999999}},at)!};
    const ranked=topCompanyRows([...rows,duplicate,etf,noQuote,missing,foreign,unlabelled]);
    expect(ranked).toHaveLength(20);expect(new Set(ranked.map(r=>r.isin)).size).toBe(20);
    expect(ranked.map(r=>r.listedData!.companyCap!.value)).toEqual(Array.from({length:20},(_,i)=>10000-i));
    expect(compareCompanyCaps(rows[0],foreign)).toBeLessThan(0);
    expect(compareCompanyCaps(unlabelled,foreign)).toBeLessThan(0);
    expect(compareCompanyCaps(missing,foreign,'asc')).toBeGreaterThan(0);
    expect(compareCompanyCaps(etf,rows[0])).toBeGreaterThan(0);
  });

  it('validates the recorded public six-mint sample without inventing token prices or currencies', () => {
    const rows = Object.entries(sample.data).map(([mint, data]) => parseMarketEnrichment(mint, data, at));
    expect(rows.filter(row => row?.referencePrice)).toHaveLength(5);
    expect(rows.filter(row => row?.referencePrice?.currency)).toHaveLength(0);
    expect(rows.filter(row => row?.multiplier)).toHaveLength(2);
    expect(Object.values(sample.data).filter(row => 'usdPrice' in row)).toHaveLength(2);
    expect(rows.find(row => row?.mint === a)?.referencePrice?.observedAt).toBeTruthy();
  });

  it('rejects invalid supplementary fields independently, preserving genuine zero liquidity', () => {
    const value = parseMarketEnrichment(a, { liquidity: 0, priceChange24h: -2.5,
      stockData: { price: '12', mcap: -1, currency: 'US' }, scaledUiConfig: { multiplier: Infinity } }, at)!;
    expect(value).toMatchObject({ referencePrice: null, companyCap: null, liquidity: { value: 0 },
      change24h: { value: -2.5 }, multiplier: null });
  });

  it('publishes reference-only rows and keeps per-field original timestamps through failures', async () => {
    const store = new MemoryMarketSnapshotStore();
    expect(await runMarketPriceCycle(cycle(store))).toMatchObject({ status: 'published' });
    const first = (await store.readCurrent())!;
    expect(first.prices!.rows[1]).toMatchObject({ attempt: 'omitted', observation: null,
      enrichment: { referencePrice: { value: 5, retrievedAt: at } } });
    const later = new Date(t + 10_000).toISOString();
    await runMarketPriceCycle(cycle(store, { cycleId: 'second', now: () => t + 10_000,
      readBatch: async () => ({ status: 'ok', observations: [],
        enrichments: [parseMarketEnrichment(a, { liquidity: 99 }, later)!] }) }));
    const current = (await store.readCurrent())!;
    expect(current.prices!.rows[0]).toMatchObject({ retainedLastGood: true, observation: { retrievedAt: at },
      enrichment: { liquidity: { value: 99, retrievedAt: later }, referencePrice: { value: 11, retrievedAt: at } } });
    expect(current.prices!.rows[1].enrichment).toEqual(first.prices!.rows[1].enrichment);
  });

  it('Listed filtering retains references and Tokenized filtering does not substitute them', async () => {
    const store = new MemoryMarketSnapshotStore();
    await runMarketPriceCycle(cycle(store));
    const read = await readMarketSnapshot({ store, nowMs: t, bundledCatalog: catalog });
    const tokenized = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ price: 'observed' }), nowMs: t });
    const listed = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ view: 'listed', price: 'observed' }), nowMs: t });
    expect(tokenized.pagination.total).toBe(1);
    expect(listed.pagination.total).toBe(2);
    expect(listed.summary.referencePriceCount).toBe(2);
    expect(legacySnapshotRecords(read.snapshot!).find(row => row.mint === b)?.priceUsd).toBeNull();
    const stale = ageCanonicalPage(tokenized, t + 601_000, true);
    expect(stale.records[0]).toMatchObject({ price: null, displayPrice: { status: 'UNAVAILABLE', priceUsd: null } });
    const detail = projectCanonicalDetail(read, tokenized.records[0].id, t)!;
    expect(ageCanonicalDetail(detail, t + 46_000).selectedPrice.selected).toBeNull();
  });

  it('restores committed snapshots after restart and excludes overlapping processes on the same volume', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'positionlayer-phase1-')); directories.push(directory);
    const first = new DurableMarketSnapshotStore(directory);
    try {
      await runMarketPriceCycle(cycle(first));
      expect(() => new DurableMarketSnapshotStore(directory)).toThrow('Another market writer');
      const attempt = spawnSync(process.execPath, ['--conditions=react-server', '--require', 'tsx/cjs', '-e',
        `const { DurableMarketSnapshotStore } = require('./src/services/market-durable-store.ts');
         try { const store = new DurableMarketSnapshotStore(process.argv[1]); store.close(); process.exitCode=2; }
         catch { process.stdout.write('LOCKED'); }`, directory], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
      expect(attempt.status, attempt.stderr).toBe(0); expect(attempt.stdout).toBe('LOCKED');
    } finally { first.close(); }
    const restarted = new DurableMarketSnapshotStore(directory);
    try {
      expect((await restarted.readCurrent())?.prices?.rows[0].observation?.retrievedAt).toBe(at);
      const read = await readMarketSnapshot({ store: restarted, nowMs: t + 180_000, bundledCatalog: catalog });
      expect(read).toMatchObject({ source: 'current', degraded: true });
      expect(projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({}), nowMs: t + 180_000 })
        .records.find(row => row.variantMints.includes(a))?.displayPrice.status).toBe('STALE');
    } finally { restarted.close(); }
  });

  it('never exposes an unpublished memory pointer when durable commit fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'positionlayer-phase1-')); directories.push(directory);
    const store = new DurableMarketSnapshotStore(directory);
    await runMarketPriceCycle(cycle(store));
    store.close();
    expect(await runMarketPriceCycle(cycle(store, { cycleId: 'cannot-commit' }))).toMatchObject({ status: 'store-unavailable' });
    expect((await store.readCurrent())?.id).toBe('phase-one-cycle');
  });

  it('releases the OS writer lock after abrupt process exit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'positionlayer-phase1-')); directories.push(directory);
    const child = spawnSync(process.execPath, ['--conditions=react-server', '--require', 'tsx/cjs', '-e',
      `const { DurableMarketSnapshotStore } = require('./src/services/market-durable-store.ts');
       new DurableMarketSnapshotStore(process.argv[1]); process.exit(7);`, directory],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
    expect(child.status, child.stderr).toBe(7);
    const next = new DurableMarketSnapshotStore(directory);
    next.close();
  });

  it('falls back to a validated previous durable snapshot when the newest payload is corrupt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'positionlayer-phase1-')); directories.push(directory);
    const first = new DurableMarketSnapshotStore(directory);
    try {
      await runMarketPriceCycle(cycle(first));
      await runMarketPriceCycle(cycle(first, { cycleId: 'newest' }));
    } finally { first.close(); }
    const database = new DatabaseSync(join(directory, 'snapshots.sqlite'));
    try { database.prepare('UPDATE snapshots SET payload=? WHERE id=?').run('{invalid', 'newest'); }
    finally { database.close(); }
    const restored = new DurableMarketSnapshotStore(directory);
    try { expect((await restored.readCurrent())?.id).toBe('phase-one-cycle'); }
    finally { restored.close(); }
  });

  it('aborts an in-flight cycle without publishing partial data', async () => {
    const store = new MemoryMarketSnapshotStore(), controller = new AbortController();
    const result = await runMarketPriceCycle(cycle(store, { signal: controller.signal,
      readBatch: async () => { controller.abort(); return { status: 'ok', observations: [observed] }; } }));
    expect(result.status).toBe('lost-lease'); expect(await store.readCurrent()).toBeNull();
  });

  it('Vercel cannot become a writer, and repeated legacy visitors never call providers', async () => {
    vi.stubEnv('VERCEL', '1'); vi.stubEnv('MARKET_V2_WRITER_ENABLED', 'true'); vi.stubEnv('MARKET_V2_WRITER_ORIGIN', '');
    expect(marketWriterAllowed()).toBe(false);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
    const pages = await Promise.all(Array.from({ length: 6 }, () => readStockMarketPage(StockMarketQuerySchema.parse({}))));
    expect(pages.every(result => result.page.records.length > 0)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it('retains a validated remote page during outage, aging prices without changing source times', async () => {
    const store = new MemoryMarketSnapshotStore(); await runMarketPriceCycle(cycle(store));
    const read = await readMarketSnapshot({ store, nowMs: t, bundledCatalog: catalog });
    const query = CanonicalMarketQuerySchema.parse({});
    const page = projectCanonicalMarket({ read, query, nowMs: t });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page)).mockRejectedValue(new Error('outage'));
    const first = await readRemoteCanonicalPage('https://phase-one.example', query, fetcher);
    clock.mockReturnValue(t + 130_000);
    const failed = await readRemoteCanonicalPage('https://phase-one.example', query, fetcher);
    expect(failed.source).toBe('local-previous');
    expect(failed.records.find(row => row.variantMints.includes(a))?.displayPrice.status).toBe('STALE');
    expect(failed.prices.completedAt).toBe(first.prices.completedAt);
    clock.mockReturnValue(t + 3_600_001);
    await expect(readRemoteCanonicalPage('https://phase-one.example', query, fetcher)).rejects.toThrow('outage');
  });
});
