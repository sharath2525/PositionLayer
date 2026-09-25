import 'server-only';
import { z } from 'zod';
import { JupiterStockTokenSchema, normalizeStockUniverse } from './stocks';
import { jupiterJson, JupiterApiError } from '@/adapters/jupiter-api/client';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { MarketMintSchema } from '@/domain/market-types';
import { ProviderCandidateSchema, type ProviderCandidate, type ProviderIssue } from '@/domain/market-provider';
import { MarketProviderCache, MarketProviderError, type ProviderLoad } from './provider-cache';

const TaggedListSchema = z.array(JupiterStockTokenSchema).max(5000);
type TaggedList = z.infer<typeof TaggedListSchema>;

/** Candidate discovery only: Jupiter's stocks tag never confers issuer verification. */
export function createJupiterStocksDiscovery(options: {
  loadTag?: () => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
} = {}) {
  const loadTag = options.loadTag ?? (() => jupiterJson('/tokens/v2/tag?query=stocks', TaggedListSchema,
    undefined, 'keyless-global-market', 'token_metadata'));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const cache = new MarketProviderCache({ provider: 'jupiter-stocks-tag', monitoringProvider: 'JUPITER',
    operation: 'token_metadata', ttlMs: 15 * 60_000, staleMs: 24 * 60 * 60_000, now: options.now });
  const load = async (): Promise<ProviderLoad> => {
    let payload: TaggedList;
    try {
      let response: TaggedList | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { response = TaggedListSchema.parse(await loadTag()); break; }
        catch (error) {
          const transient = (error instanceof JupiterApiError &&
            (error.kind === 'timeout' || (error.kind === 'http' && error.status !== null && error.status >= 500)))
            || error instanceof TypeError;
          if (!transient || attempt === 1) throw error;
          await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
        }
      }
      if (response === null) throw new MarketProviderError('INVALID_RESPONSE');
      payload = response;
    }
    catch (error) {
      if (error instanceof JupiterApiError) {
        const issue: ProviderIssue = error.kind === 'rate-limited' ? 'RATE_LIMIT'
          : error.kind === 'timeout' ? 'TIMEOUT' : error.kind === 'malformed' ? 'INVALID_RESPONSE'
            : error.kind === 'http' ? (error.status !== null && error.status >= 500 ? 'HTTP_SERVER' : 'HTTP_CLIENT') : 'NETWORK';
        throw new MarketProviderError(issue, error.status, error.retryAfterSeconds);
      }
      if (error instanceof TypeError) throw new MarketProviderError('NETWORK');
      throw new MarketProviderError('INVALID_RESPONSE');
    }
    const retrievedAt = new Date(options.now?.() ?? Date.now()).toISOString();
    const records: ProviderCandidate[] = [];
    const seen = new Set<string>();
    const issues: ProviderIssue[] = [];
    for (const token of payload) {
      if (!MarketMintSchema.safeParse(token.id).success) { issues.push('INVALID_RECORD'); continue; }
      if (seen.has(token.id)) continue;
      seen.add(token.id);
      try {
        const row = normalizeStockUniverse([], [token], retrievedAt)[0];
        const variant = adaptLegacyXstockRecord(row).variant;
        // A 24h buy+sell total is not known if either side is absent. The
        // legacy view keeps its existing normalization; canonical stays strict.
        variant.reportedVolume24hUsd = token.stats24h?.buyVolume != null
          && token.stats24h.sellVolume != null ? variant.reportedVolume24hUsd : null;
        records.push(ProviderCandidateSchema.parse({ variant, supply: null }));
      } catch { issues.push('INVALID_RECORD'); }
    }
    return { records, complete: !issues.includes('INVALID_RECORD'), issues };
  };
  return { read: () => cache.read(load), reset: () => cache.reset() };
}

const shared = createJupiterStocksDiscovery();
export const readJupiterStocksTagCandidates = shared.read;
