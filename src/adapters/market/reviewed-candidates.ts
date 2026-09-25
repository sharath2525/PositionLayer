import 'server-only';
import { activeSolanaXstockAssets, normalizeStockUniverse, snapshotXstockAssets } from './stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { ProviderCandidateSchema, type ProviderCandidate } from '@/domain/market-provider';

/** Dated, bundled issuer identities only. This makes zero provider requests. */
export function readReviewedMarketCandidates(): ProviderCandidate[] {
  const snapshot = snapshotXstockAssets();
  return normalizeStockUniverse(activeSolanaXstockAssets(snapshot.assets), [], snapshot.verifiedAt)
    .map(record => ProviderCandidateSchema.parse({
      variant: adaptLegacyXstockRecord(record).variant,
      supply: null,
    }));
}
