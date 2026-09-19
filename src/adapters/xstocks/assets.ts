import 'server-only';
import { z } from 'zod';
import { companyForTicker, sectorMap } from '@/config/companies';
import { featuredXstocks } from '@/config/featured-stocks';
import { observeProviderCall } from '@/services/monitoring/instrument-provider';

const ISSUER_BASE = 'https://api.xstocks.fi/api/v2/public/assets';
const DeploymentSchema = z.object({ address: z.string(), network: z.string() }).passthrough();
const IssuerAssetSchema = z.object({
  name: z.string(), symbol: z.string(), underlyingSymbol: z.string(), underlyingIsin: z.string(),
  logo: z.string().url().regex(/^https:\/\//).optional(),
  deployments: z.array(DeploymentSchema),
}).passthrough();

export type XstockIdentity = {
  mint: string; symbol: string; name: string; underlyingSymbol: string; securityId: string;
  companyId: string; sector: string | null; assetClass: 'stock' | 'etf'; identitySource: string; logoUrl: string | null;
};

function identity(record: z.infer<typeof IssuerAssetSchema>, mint: string): XstockIdentity | null {
  if (!record.deployments.some(deployment => deployment.network === 'Solana' && deployment.address === mint)) return null;
  const assetClass = ['SPY', 'QQQ'].includes(record.underlyingSymbol) ? 'etf' as const : 'stock' as const;
  const companyId = companyForTicker(record.underlyingSymbol, record.underlyingIsin);
  return { mint, symbol: record.symbol, name: record.name.replace(/ xStock$/i, ''), underlyingSymbol: record.underlyingSymbol,
    securityId: record.underlyingIsin, companyId, sector: sectorMap[companyId] || null, assetClass,
    identitySource: `${ISSUER_BASE}/${encodeURIComponent(record.symbol)}`, logoUrl: record.logo || null };
}

// Exact issuer responses checked 2026-09-14. Runtime discovery below covers additional xStocks;
// these records keep the common holdings usable when the issuer endpoint is temporarily unavailable.
const checked = featuredXstocks.map(row => identity({ ...row, logo:`https://xstocks-metadata.backed.fi/logos/tokens/${row.symbol}.png`, deployments:[{network:'Solana',address:row.mint}] }, row.mint)!) satisfies XstockIdentity[];
const backpackChecked: XstockIdentity[] = [{
  mint: 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb', symbol: 'SPCX',
  name: 'SpaceX - Backpack Securities', underlyingSymbol: 'SPCX', securityId: 'BACKPACK:SPCX',
  companyId: 'SPACEX', sector: sectorMap.SPACEX, assetClass: 'stock',
  identitySource: 'https://learn.backpack.exchange/blog/tokenized-spacex-spcx', logoUrl: null,
}];
const checkedByMint = new Map([...checked, ...backpackChecked].map(row => [row.mint, row]));

export async function readXstockIdentities(candidates: { mint: string; symbol: string; verified: boolean }[], signal?: AbortSignal) {
  const result = new Map<string, XstockIdentity>();
  const unresolved: { mint: string; symbol: string }[] = [];
  for (const candidate of candidates) {
    const known = checkedByMint.get(candidate.mint);
    if (known) { result.set(candidate.mint, known); continue; }
    if (candidate.verified && /x$/i.test(candidate.symbol)) unresolved.push(candidate);
  }
  await Promise.allSettled(unresolved.map(async candidate => {
    await observeProviderCall({ provider: 'XSTOCKS', operation: 'identity_lookup' }, async () => {
      const timeout = AbortSignal.timeout(6000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const url = `${ISSUER_BASE}/${encodeURIComponent(candidate.symbol)}`;
      let response: Response;
      try { response = await fetch(url, { signal: combined, headers: { accept: 'application/json' }, next: { revalidate: 86400 } }); }
      catch (error) {
        if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
        if (timeout.aborted) throw Error('xStocks identity lookup timed out.');
        throw error;
      }
      if (!response.ok) throw Error(`xStocks identity lookup HTTP ${response.status}`);
      let body: unknown;
      try { body = await response.json(); } catch { throw Error('xStocks identity lookup returned invalid JSON.'); }
      const parsed = IssuerAssetSchema.safeParse(body);
      if (!parsed.success) throw Error('xStocks identity lookup failed schema validation.');
      const verified = identity(parsed.data, candidate.mint);
      if (verified) result.set(candidate.mint, verified);
    });
  }));
  return result;
}
