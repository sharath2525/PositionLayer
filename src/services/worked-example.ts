import { samplePortfolio, sampleSource } from './sample';
import { normalizePosition } from '@/adapters/jupiter-lend/normalize';
import { byId } from '@/config/instruments';
import { referenceValue } from '@/domain/valuation';

// Deliberately illustrative values from BUILD_PLAN.md, never used in live mode.
export function workedExamplePortfolio() {
  const p = samplePortfolio(); p.id='sample-worked-example-v2';
  const source = {...sampleSource,id:'sample-worked-example-v2',label:'Illustrative Phase 2 worked example: not onchain'};
  const loan = normalizePosition({vaultId:80,positionId:1,owner:'sample-owner',requestedOwner:'sample-owner',positionAddress:'sample-worked-position',positionMint:'sample-worked-receipt',
    supplyMint:byId.NVDAx.mint,borrowMint:byId.USDC.mint,supply1e9:'80000000000',borrow1e9:'6500000000000',vaultType:0,
    collateralFactorPermille:'650',liquidationThresholdPermille:'780',liquidationPenaltyBps:'300',liquidatePrice1e15:'125000000000000000',isLiquidated:false,source});
  const posted=p.holdings.find(h=>h.scope==='deposited')!;
  posted.rawAmount='80000000000';posted.unscaledAmount='80';posted.displayAmount='80';posted.source=source;
  posted.referenceValue=referenceValue(posted,p.prices.find(p=>p.instrumentId==='NVDAx'));
  p.loans=[loan];p.issues.push('Worked example: 10,000 USDC collateral, 6,500 USDC debt, and a 78% liquidation threshold. These are illustrative, not current vault parameters.');
  return p;
}

// Keeps the Phase 1 golden example unchanged while adding a separate Phase 2
// fixture whose selected plan has a visible USDC funding shortfall.
export function liquidityExamplePortfolio() {
  const p=workedExamplePortfolio();p.id='sample-liquidity-example-v1';
  const cash=p.holdings.find(h=>h.scope==='wallet'&&h.instrumentId==='USDC')!;
  cash.rawAmount='500000000';cash.spendableRawAmount='500000000';cash.unscaledAmount='500';cash.displayAmount='500';cash.spendableAmount='500';
  p.issues=p.issues.map(issue=>issue.startsWith('Worked example:')
    ?'Liquidity example: 10,000 USDC collateral, 6,500 USDC debt, 500 USDC free cash, and a 78% liquidation threshold. These are illustrative, not current vault parameters.'
    :issue);
  return p;
}
