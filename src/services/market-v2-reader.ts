import 'server-only';
import { projectCanonicalDetail, projectCanonicalMarket, type CanonicalMarketQuery } from '@/domain/market-api-v2';
import { readMarketSnapshot } from './market-snapshot-reader';
import { getProcessMarketSnapshotStore } from './market-snapshot-store';
import { bundledMarketV2Catalog } from './market-v2-engine';
import { marketV2WriterOrigin, readRemoteCanonicalDetail, readRemoteCanonicalPage } from './market-v2-remote';
import { recordMarketEvent } from './monitoring/log-manager';

async function currentRead() {
  const store = getProcessMarketSnapshotStore();
  const [read, progress] = await Promise.all([
    readMarketSnapshot({ store, bundledCatalog: bundledMarketV2Catalog(), nowMs: Date.now() }),
    store.readProgress().catch(() => null),
  ]);
  return { read, progress };
}

/** Versioned API reader. It cannot start or prioritize a provider cycle. */
export async function readCanonicalMarketPage(query: CanonicalMarketQuery) {
  const origin = marketV2WriterOrigin();
  if (origin) {
    try { return await readRemoteCanonicalPage(origin, query); }
    catch {
      recordMarketEvent({ severity: 'WARN', provider: 'CACHE', operation: 'cache_load',
        status: 'CACHE_STALE_FALLBACK', errorCode: 'CACHE_LOAD',
        message: 'Canonical writer read failed; local reviewed catalog is shown without fabricated prices.',
        fallbackUsed: 'reviewed-catalog' });
    }
  }
  const { read, progress } = await currentRead();
  return projectCanonicalMarket({ read, query, nowMs: Date.now(), progress });
}

export async function readCanonicalMarketDetail(assetId: string) {
  const origin = marketV2WriterOrigin();
  if (origin) {
    try { return await readRemoteCanonicalDetail(origin, assetId); }
    catch {
      recordMarketEvent({ severity: 'WARN', provider: 'CACHE', operation: 'cache_load',
        status: 'CACHE_STALE_FALLBACK', errorCode: 'CACHE_LOAD',
        message: 'Canonical writer detail read failed; local reviewed identity is shown without fabricated prices.',
        fallbackUsed: 'reviewed-catalog' });
    }
  }
  const { read } = await currentRead();
  return projectCanonicalDetail(read, assetId, Date.now());
}
