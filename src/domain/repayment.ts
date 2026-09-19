import { marketCalendar } from '@/config/market-calendar';
import { decimal, D, fromBaseUnits, ratio } from './amounts';
import { identityIssues, multiplierEvent, REVIEW_MAX_AGE_MS, snapshotKey, sourceState, type ReadContext } from './guards';
import { RepaymentPlanSchema, type RepaymentPlan, type ScenarioSpec } from './planning-types';
import { scenarioForLoan } from './stress';
import { summary } from './valuation';
import type { Portfolio } from './types';

export function buildRepaymentPlan(portfolio: Portfolio, loanId: string, scenario: ScenarioSpec, target: string, targetBasis: 'current' | 'stressed', context: ReadContext): RepaymentPlan {
  if (!Number.isFinite(context.now)) throw Error('Review time is unavailable');
  const loan = portfolio.loans.find(l=>l.id===loanId);
  if (!loan) throw Error('Selected position is not in this snapshot');
  const result = scenarioForLoan(portfolio,loan,scenario,context);
  const blockers = [...result.blockers]; const warnings = [...result.warnings];
  let validTarget = false;
  try { validTarget = decimal(target).gt(0) && decimal(target).lt(loan.liquidationThreshold); } catch { /* shown as input validation */ }
  if (!validTarget) blockers.push('Target must be greater than 0 and strictly below this loan’s liquidation threshold.');
  const availableUsdc = summary(portfolio).freeUsdc;
  if (availableUsdc===null) blockers.push('Spendable USDC balance is unverified.');
  const cash = portfolio.holdings.filter(h=>h.instrumentId==='USDC'&&h.scope==='wallet');
  if (portfolio.mode==='live' && (context.now-Date.parse(portfolio.observedAt)>120000 || Date.parse(portfolio.observedAt)>context.now+5000)) blockers.push('Wallet balance snapshot is stale or future-dated.');
  if (cash.some(h=>![h.source,h.mintState.source].every(s=>['fresh','sample'].includes(sourceState(s,portfolio.mode,context.now))))) blockers.push('USDC amount/mint observations are stale or unverified.');
  const basisCollateral = targetBasis==='current'?result.collateralNow:result.collateralStressed;
  let repaymentBaseUnits: string | null = null; let repaymentUsdc: string | null = null;
  if (validTarget && basisCollateral!==null && decimal(basisCollateral).gt(0) && result.debt!==null) {
    // Round UP to a whole USDC base unit so the rounded amount does not miss the target.
    const needed = D.max(0,decimal(result.debt).sub(decimal(target).mul(basisCollateral)));
    repaymentBaseUnits = needed.mul('1000000').ceil().toFixed(0);
    repaymentUsdc = fromBaseUnits(repaymentBaseUnits,6);
    if (decimal(repaymentUsdc).gt(result.debt)) blockers.push('Debt is below the required whole-token-unit rounding. A verified repay-all/dust path is needed; this preview cannot specify it.');
  }
  const remainingCashUsdc = availableUsdc!==null && repaymentUsdc!==null ? decimal(availableUsdc).sub(repaymentUsdc).toFixed() : null;
  const shortfallUsdc = remainingCashUsdc===null?null:D.max(0,decimal(remainingCashUsdc).neg()).toFixed();
  const cashCoverage = availableUsdc===null || repaymentUsdc===null ? null : decimal(repaymentUsdc).eq(0) ? '1' : D.min(1,decimal(availableUsdc).div(repaymentUsdc)).toFixed();
  if (shortfallUsdc!==null && decimal(shortfallUsdc).gt(0)) warnings.push(`Spendable USDC does not fully cover this protection plan. Shortfall: ${shortfallUsdc} USDC.`);
  const expectedDebtUsdc = result.debt!==null && repaymentUsdc!==null && decimal(repaymentUsdc).lte(result.debt) ? decimal(result.debt).sub(repaymentUsdc).toFixed() : null;
  const expectedCurrentLtv = expectedDebtUsdc!==null && result.collateralNow!==null ? ratio(expectedDebtUsdc,result.collateralNow) : null;
  const expectedScenarioLtv = expectedDebtUsdc!==null && result.collateralStressed!==null ? ratio(expectedDebtUsdc,result.collateralStressed) : null;
  const stock = portfolio.holdings.find(h=>h.instrumentId===loan.collateralInstrumentId);
  if (stock && multiplierEvent(stock.mintState,context.now).status!=='current') warnings.push('Stock multiplier update affects display/trade prices. Pure USDC repayment is assessed separately using protocol USDC values; it still needs its own refreshed simulation.');
  if (portfolio.loanRead!=='ready') warnings.push('Portfolio loan coverage is incomplete. This plan concerns only the selected position.');
  warnings.push('No executable DEX quote is used. Fees, rent, interest accrual and a fresh protocol simulation remain outside this estimate.');
  const assumptions = [...result.assumptions,'Target is a ratio below the selected loan’s liquidation threshold.',
    'Round repayment upward to 0.000001 USDC. No USD/USDC peg or dollar conversion is assumed.',
    'Repayment spends existing free USDC and reduces debt equally; stock quantities and immediate net equity stay unchanged before fees and market changes.',
    'Other loans are unchanged. Independent plans share the same wallet cash and cannot be added together as funded commitments.'];
  const sources = [...new Map([loan.source,...portfolio.holdings.flatMap(h=>[h.source,h.mintState.source]),...portfolio.prices.map(p=>p.source),...portfolio.etfs.map(e=>e.source),...(loan.collateralValue?[loan.collateralValue.source]:[]),...(loan.debtValue?[loan.debtValue.source]:[])].map(s=>[s.id,s])).values()];
  return RepaymentPlanSchema.parse({ schemaVersion:2,id:`plan:${portfolio.id}:${loan.id}:${JSON.stringify(scenario)}:${targetBasis}:${target}:${context.now}`,mode:portfolio.mode,owner:portfolio.owner,cluster:portfolio.cluster,
    status:blockers.length?'blocked':repaymentUsdc==='0'?'not-needed':result.status==='partial'?'partial':'ready',executable:false,
    createdAt:new Date(context.now).toISOString(),expiresAt:new Date(context.now+REVIEW_MAX_AGE_MS).toISOString(),inputKey:snapshotKey(portfolio),inputSnapshot:portfolio,sources,calendarId:marketCalendar.id,
    positionId:loan.id,target,targetBasis,scenario,result,currency:'USDC',amountUnit:'USDC-base-unit',decimals:6,
    repaymentBaseUnits,repaymentUsdc,availableUsdc,cashCoverage,remainingCashUsdc,shortfallUsdc,expectedDebtUsdc,expectedCurrentLtv,expectedScenarioLtv,
    stockQuantityChanges:false,netEquityChangeBeforeFeesUsdc:'0',assumptions,warnings,blockers:[...new Set(blockers)] });
}

export function validatePlanReview(plan: RepaymentPlan, portfolio: Portfolio, context: ReadContext): string[] {
  const issues = identityIssues(portfolio,context);
  if (plan.owner!==context.owner || plan.cluster!==context.cluster || plan.mode!==portfolio.mode) issues.push('Review wallet, cluster or data mode changed.');
  if (plan.inputKey!==snapshotKey(portfolio)) issues.push('Input snapshot changed. Create a new review.');
  if (context.now>=Date.parse(plan.expiresAt) || context.now<Date.parse(plan.createdAt)) issues.push('Review expired or clock changed. Refresh inputs and create a new review.');
  if (plan.status==='blocked'||plan.status==='not-needed') issues.push('This plan is not reviewable for an action.');
  if (!portfolio.loans.some(l=>l.id===plan.positionId)) return [...new Set([...issues,'Selected position is no longer in this snapshot. Create a new review.'])];
  if (!Number.isFinite(context.now)) return [...new Set([...issues,'Review time is unavailable.'])];
  const latest = buildRepaymentPlan(portfolio,plan.positionId,plan.scenario,plan.target,plan.targetBasis,context);
  return [...new Set([...issues,...latest.blockers])];
}
