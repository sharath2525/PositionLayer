import 'server-only';
import { projectCanonicalDetail, projectCanonicalMarket, withDexDisplay, type CanonicalMarketQuery } from '@/domain/market-api-v2';
import { canQueryExactIssuerPrice } from '@/domain/market-price-policy';
import { readMarketSnapshot } from './market-snapshot-reader';
import { getProcessMarketSnapshotStore } from './market-snapshot-store';
import { getRuntimeMarketSnapshotStore } from './market-durable-store';
import { bundledMarketV2Catalog } from './market-v2-engine';
import { marketV2WriterOrigin, readRemoteCanonicalDetail, readRemoteCanonicalPage } from './market-v2-remote';
import { recordMarketEvent } from './monitoring/log-manager';
import { currentRichStore } from './stock-rich-store';
import { ageRichData } from '@/domain/stock-rich-data';

export async function readCurrentMarketSnapshot() {
  let store;
  try { store = getRuntimeMarketSnapshotStore(); }
  catch { store = getProcessMarketSnapshotStore(); }
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
  const { read, progress } = await readCurrentMarketSnapshot();
  const rich=currentRichStore();
  const page = projectCanonicalMarket({ read, query, nowMs: Date.now(), progress, rich:rich?.rows, enrichmentVersion:rich?.version });
  // Reuse the persistent host's existing optional context. Page visits do not fetch it.
  const { getCachedStockContext } = await import('./stocks-market');
  for (const row of page.records) {
    const context = getCachedStockContext(row.displayPrice.mint)?.record.intelligence;
    if (context && row.verification === 'issuer-confirmed') row.issuerContext = {
      issuerIndicativePriceUsd: context.issuerIndicativePriceUsd,
      issuerPriceRetrievedAt: context.issuerPriceRetrievedAt,
      issuerPriceSourceUrl: context.issuerPriceSourceUrl,
      supply: context.supply, reserve: context.reserve,
    };
  }
  return page;
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
  const { read } = await readCurrentMarketSnapshot();
  const detail = projectCanonicalDetail(read, assetId, Date.now());
  if (detail) {
    detail.enrichmentVersion=currentRichStore()?.version??null;
    for(const row of detail.variants){
      row.rich=row.conflicts.length===0&&row.variant.verification==='issuer-confirmed'?ageRichData(currentRichStore()?.rows.get(row.mint)):null;
      const entry=read.snapshot?.catalog.registry.entries.find(e=>e.variant.mint===row.mint);
      row.displayPrice=withDexDisplay(row.displayPrice,row.rich,Boolean(entry&&canQueryExactIssuerPrice(entry)&&entry.conflicts.length===0),Date.now());
    }
    const { getCachedStockContext } = await import('./stocks-market');
    const mint = detail.variants.find(row => getCachedStockContext(row.mint))?.mint;
    if (mint) detail.context = await (await import('./market-legacy-reader')).readManagedLegacyDetail(mint);
  }
  return detail;
}
