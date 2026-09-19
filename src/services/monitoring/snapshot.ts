import 'server-only';
import { MonitoringSnapshotSchema } from '@/domain/monitoring';
import { getStockMarketCacheStats } from '@/services/stocks-market';
import { monitoringStore } from './log-manager';
import { providerHealthSnapshot } from './provider-health';

export function readMonitoringSnapshot() {
  const market = getStockMarketCacheStats();
  return MonitoringSnapshotSchema.parse({
    generatedAt: new Date().toISOString(),
    retentionHours: 6,
    store: monitoringStore().stats(),
    providers: providerHealthSnapshot(),
    events: monitoringStore().read(100),
    engine: {
      universeLoads: market.universeLoads,
      metadataLoads: market.metadataLoads,
      solanaMintLoads: market.solanaMintLoads,
      priceLoads: market.priceLoads,
      priceCycles: market.priceCycles,
      priceFailures: market.priceFailures,
      priceKeys: market.priceKeys,
      meteoraIndexLoads: market.meteoraIndexLoads,
      meteoraDetailLoads: market.meteoraDetailLoads,
      worker: market.worker,
    },
  });
}
