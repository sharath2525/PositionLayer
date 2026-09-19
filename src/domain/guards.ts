import { decimal } from './amounts';
import type { MintState, Portfolio, PriceObservation, Source } from './types';

export const PRICE_MAX_AGE_MS = 120000;
export const REVIEW_MAX_AGE_MS = 60000;
export const HOLDINGS_MAX_AGE_MS = 7 * 86400000;
export type ReadContext = { owner: string | null; cluster: string; now: number };
export function accountSources(portfolio: Portfolio): Source[] {
  return [
    ...portfolio.loans.flatMap(l => [l.source, ...(l.collateralValue ? [l.collateralValue.source] : []), ...(l.debtValue ? [l.debtValue.source] : [])]),
    ...portfolio.holdings.flatMap(h => [h.source, h.mintState.source, ...(h.referenceValue ? [h.referenceValue.source] : [])]),
    ...(portfolio.walletAssets || []).flatMap(asset => [asset.source, ...(asset.referenceValue ? [asset.referenceValue.source] : [])]),
    ...(portfolio.earnPositions || []).flatMap(position => [position.source, ...(position.referenceValue ? [position.referenceValue.source] : [])]),
    ...(portfolio.unmodeledLoans || []).map(position => position.source),
    ...(portfolio.indexedPositions || []).map(position => position.source),
    ...portfolio.prices.map(p => p.source),
  ];
}
export function sourceState(source: Source, mode: Portfolio['mode'], now: number, maxAge = PRICE_MAX_AGE_MS): 'fresh' | 'stale' | 'unverified' | 'sample' {
  if (source.validity === 'unverified') return 'unverified';
  if (source.validity === 'stale') return 'stale';
  if (source.kind === 'sample') return mode === 'sample' ? 'sample' : 'unverified';
  if (source.kind === 'hypothetical' || !Number.isFinite(now)) return 'unverified';
  const age = now - Date.parse(source.observedAt);
  return !Number.isFinite(age) || age < -5000 ? 'unverified' : age > maxAge ? 'stale' : 'fresh';
}
export function identityIssues(portfolio: Portfolio, context: ReadContext): string[] {
  const issues: string[] = [];
  if (context.cluster !== portfolio.cluster || context.cluster !== 'solana:mainnet') issues.push('Wallet/RPC cluster changed. Read the portfolio again.');
  if (context.owner !== portfolio.owner) issues.push('Wallet changed. This snapshot belongs to another wallet.');
  if (portfolio.mode === 'live') {
    if (!portfolio.owner || [...portfolio.loans,...portfolio.holdings,...(portfolio.walletAssets || []),...(portfolio.earnPositions || []),...(portfolio.unmodeledLoans || [])].some(x => x.owner !== portfolio.owner)) issues.push('Snapshot ownership is inconsistent.');
    if (accountSources(portfolio).some(s=>s.kind!=='live')) issues.push('Live snapshot contains non-live numeric observations.');
  }
  return issues;
}
export function multiplierEvent(mint: MintState, now: number) {
  const hasPending = mint.pendingMultiplier !== null && mint.effectiveAt !== null;
  const crossed = hasPending && now >= mint.effectiveAt! * 1000 && mint.chainTime < mint.effectiveAt!;
  return { status: crossed ? 'refresh-required' as const : hasPending ? 'scheduled' as const : 'current' as const,
    multiplier: mint.multiplier, pendingMultiplier: mint.pendingMultiplier, effectiveAt: mint.effectiveAt,
    stockActionsAffected: crossed, pureUsdcRepaymentAffected: false,
    note: crossed ? 'Scheduled multiplier time has passed. Refresh chain state and matching prices before a stock trade preview.' : hasPending ? 'A multiplier update is scheduled. Stock quantity and price must use the same event state.' : 'Observed effective multiplier; no pending update in this snapshot.' };
}
export function priceMatchesEvent(price: PriceObservation, mint: MintState): boolean {
  if (price.per === 'display-token' && (price.multiplier === null || !decimal(price.multiplier).eq(mint.multiplier))) return false;
  if (mint.effectiveAt && mint.chainTime >= mint.effectiveAt && Date.parse(price.source.observedAt) < mint.effectiveAt * 1000) return false;
  return true;
}
export function snapshotKey(portfolio: Portfolio): string {
  // Full serialized inputs, not a lossy hash or a security authorization token.
  return JSON.stringify(portfolio);
}
