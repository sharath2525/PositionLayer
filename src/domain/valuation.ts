import { decimal, sum } from './amounts';
import type { Holding, Portfolio, PriceObservation, ValueObservation } from './types';
import { priceMatchesEvent } from './guards';

export function referenceValue(holding: Holding, price: PriceObservation | undefined): ValueObservation | null {
  if (!price || price.instrumentId !== holding.instrumentId || price.basis !== 'reference' || price.currency !== 'USD' || price.source.validity === 'unverified') return null;
  if (!priceMatchesEvent(price, holding.mintState)) return null;
  const quantity = price.per === 'display-token' ? holding.displayAmount : holding.unscaledAmount;
  return { amount: decimal(quantity).mul(price.value).toFixed(), currency: 'USD', basis: 'reference', source: price.source };
}
export function summary(portfolio: Portfolio) {
  const valued = portfolio.holdings.filter(h => h.referenceValue?.currency === 'USD' && h.referenceValue.basis === 'reference');
  const valuedWalletAssets = (portfolio.walletAssets || []).filter(asset => asset.verification === 'verified' && asset.referenceValue?.currency === 'USD' && asset.referenceValue.basis === 'reference');
  const valuedEarn = (portfolio.earnPositions || []).filter(position => position.referenceValue?.currency === 'USD' && position.referenceValue.basis === 'reference');
  const assets = sum([...valued.map(h => h.referenceValue!.amount), ...valuedWalletAssets.map(asset => asset.referenceValue!.amount), ...valuedEarn.map(position => position.referenceValue!.amount)]);
  const cash = portfolio.unsupported.some(u=>u.mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') ? null : sum(portfolio.holdings.filter(h => h.instrumentId === 'USDC' && h.scope === 'wallet').map(h => h.spendableAmount));
  const usdc = portfolio.prices.find(p => p.instrumentId === 'USDC' && p.basis === 'reference' && p.currency === 'USD' && p.source.validity !== 'unverified');
  const debtUsdc = portfolio.loans.length === 0 && portfolio.loanRead !== 'ready' ? null : sum(portfolio.loans.map(l => l.debtUnscaled));
  const debtReference = usdc && debtUsdc !== null ? decimal(debtUsdc).mul(usdc.value).toFixed() : portfolio.loans.length === 0 && portfolio.loanRead === 'ready' ? '0' : null;
  const valuedCount = valued.length + valuedWalletAssets.length + valuedEarn.length;
  const totalCount = portfolio.holdings.length + (portfolio.walletAssets || []).length + (portfolio.earnPositions || []).length;
  const equity = debtReference === null || valuedCount === 0 ? null : decimal(assets).sub(debtReference).toFixed();
  const complete = valuedCount === totalCount && portfolio.loanRead === 'ready' && portfolio.unsupported.every(u => u.reason.startsWith('Position receipt')) && !(portfolio.unmodeledLoans || []).length;
  return { assetsReference: valuedCount ? assets : null, debtReference, equityReference: equity, freeUsdc: cash, debtUsdc,
    valuedHoldings: valuedCount, totalHoldings: totalCount, complete,
    postedReference: sum([...valued.filter(h => h.scope === 'deposited').map(h => h.referenceValue!.amount), ...valuedEarn.map(position => position.referenceValue!.amount)]) };
}
