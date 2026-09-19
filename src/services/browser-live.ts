import { PortfolioResultSchema, type PortfolioProvider } from '@/domain/types';
import { accountSources } from '@/domain/guards';
export const browserLiveProvider: PortfolioProvider = {
  async read(owner, signal, selection) {
    if (!owner) return { status: 'error', code: 'WALLET_REQUIRED', message: 'Connect a wallet or enter a public address to read live accounts.' };
    const response = await fetch('/api/portfolio', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({owner,selection}), signal, cache: 'no-store' });
    const result = PortfolioResultSchema.parse(await response.json());
    if (result.status !== 'error' && (result.data.mode !== 'live' || result.data.owner !== owner || result.data.cluster !== 'solana:mainnet')) throw Error('Live response identity mismatch');
    if (result.status !== 'error' && accountSources(result.data).some(s=>s.kind!=='live')) throw Error('Non-live observations are forbidden on the live channel');
    return result;
  },
};
