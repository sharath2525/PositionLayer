// Explicit one-cycle, public-market smoke check; never runs from an API request.
// node --conditions=react-server --import tsx scripts/verify-stocks-phase1.mts
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DurableMarketSnapshotStore } from '../src/services/market-durable-store';
import { refreshMarketV2Catalog, runMarketV2Once } from '../src/services/market-v2-engine';
import { CanonicalMarketQuerySchema, projectCanonicalMarket } from '../src/domain/market-api-v2';
import { readMarketSnapshot } from '../src/services/market-snapshot-reader';

const directory = resolve('.market-data/phase1-verification');
let store = new DurableMarketSnapshotStore(directory);
try {
  const previous = await store.readCurrent();
  const catalog = await refreshMarketV2Catalog({ previous: previous?.catalog ?? null });
  console.log(JSON.stringify({ stage: 'catalog', identities: catalog.registry.assets.length,
    mints: catalog.registry.entries.length }));
  const result = await runMarketV2Once({ catalog, store });
  const current = await store.readCurrent();
  if (result.status !== 'published' || !current?.prices) throw new Error(`Cycle did not publish: ${result.status}`);
  const original = current.prices.rows.find(row => row.observation)?.observation?.retrievedAt ?? null;
  store.close();
  store = new DurableMarketSnapshotStore(directory);
  const restored = await store.readCurrent();
  const read = await readMarketSnapshot({ store, bundledCatalog: catalog, nowMs: Date.now() });
  const page = projectCanonicalMarket({ read, query: CanonicalMarketQuerySchema.parse({ pageSize: 1 }), nowMs: Date.now() });
  const report = { checkedAt: new Date().toISOString(), result,
    restartPreservedSnapshot: restored?.id === current.id,
    restartPreservedTimestamp: restored?.prices?.rows.find(row => row.observation)?.observation?.retrievedAt === original,
    summary: page.summary, prices: page.prices, providers: page.providers,
    countries: [...new Set(catalog.registry.entries.map(entry => entry.variant.underlying.listingCountry))].sort() };
  mkdirSync('docs/evidence/stocks-upgrade-phase1', { recursive: true });
  writeFileSync('docs/evidence/stocks-upgrade-phase1/live-cycle.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { store.close(); }
