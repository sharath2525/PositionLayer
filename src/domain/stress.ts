import { byId, verifiedVaults } from '@/config/instruments';
import { decimal, ratio } from './amounts';
import { instrumentComposition } from './exposure';
import { sourceState, HOLDINGS_MAX_AGE_MS, identityIssues, type ReadContext } from './guards';
import { ScenarioResultSchema, ScenarioSpecSchema, type ScenarioResult, type ScenarioSpec } from './planning-types';
import type { Portfolio, Loan } from './types';

export function scenarioForLoan(portfolio: Portfolio, loan: Loan, spec: ScenarioSpec, context: ReadContext): ScenarioResult {
  const blockers = identityIssues(portfolio,context); const warnings: string[] = [];
  const assumptions = ['Accrued USDC debt and FX are held fixed at this snapshot; no future interest or fees modeled.', 'The modeled collateral return is applied to the observed protocol valuation. This is a scenario, not a new oracle reading or DEX quote.'];
  const parsed = ScenarioSpecSchema.safeParse(spec);
  if (!parsed.success) blockers.push('Invalid shock: decline must be 0–100%; company move must be -100% to +100%.');
  const supported = verifiedVaults.some(v=>v.vaultId===loan.vaultId && v.instrumentId===loan.collateralInstrumentId);
  if (!supported || loan.debtInstrumentId !== 'USDC' || !loan.capabilities.positionReadable || loan.isLiquidated) blockers.push('Position is unsupported, unreadable or liquidated.');
  const c = loan.collateralValue; const d = loan.debtValue;
  const validBasis = c?.basis==='protocol' && c.currency==='USDC' && decimal(c.amount).gte(0) && d?.basis==='protocol' && d.currency==='USDC' && decimal(d.amount).gte(0) && decimal(d.amount).eq(loan.debtUnscaled);
  if (!validBasis) blockers.push('Compatible protocol collateral/debt values in USDC are required.');
  for (const source of [loan.source,...(c?[c.source]:[]),...(d?[d.source]:[])]) {
    if (!['fresh','sample'].includes(sourceState(source,portfolio.mode,context.now))) blockers.push('Protocol snapshot is stale or unverified. Refresh before reviewing a plan.');
  }
  const composition = instrumentComposition(loan.collateralInstrumentId, portfolio.etfs);
  let modeledReturn: string | null = null; let companyWeight: string | null = null;
  if (parsed.success) {
    if (parsed.data.kind === 'broad') { modeledReturn = decimal(parsed.data.decline).neg().toFixed(); assumptions.push('Broad decline applies to all of this loan’s collateral, including undecomposed ETF coverage.'); }
    else {
      const companyId = parsed.data.companyId;
      companyWeight = composition.status === 'unavailable' ? null : composition.companies.find(c=>c.companyId===companyId)?.weight || '0';
      if (!Object.values(byId).some(i=>i.companyId===companyId) && !portfolio.etfs.some(e=>e.constituents.some(c=>c.companyId===companyId))) blockers.push('Selected company has no verified mapping in this snapshot.');
      assumptions.push('Only the selected company moves; every other constituent and all unknown ETF coverage are held fixed.');
      if (composition.status === 'unavailable') blockers.push(`${byId[loan.collateralInstrumentId]?.symbol || 'Collateral'} company composition is unavailable; no company-scenario return can be estimated.`);
      else {
        modeledReturn = decimal(companyWeight!).mul(parsed.data.change).toFixed();
        if (composition.status === 'partial') warnings.push(`Company coverage is partial. Unknown/residual weight ${composition.unknownWeight} is held fixed, not assumed absent.`);
        if (composition.source && !['fresh','sample'].includes(sourceState(composition.source,portfolio.mode,context.now,HOLDINGS_MAX_AGE_MS))) blockers.push('ETF holdings are stale or unverified for company planning (7-day policy).');
      }
    }
  }
  const collateralNow = validBasis ? c!.amount : null; const debt = validBasis ? d!.amount : null;
  const collateralStressed = collateralNow!==null && modeledReturn!==null ? decimal(collateralNow).mul(decimal('1').add(modeledReturn)).toFixed() : null;
  if (collateralNow!==null && decimal(collateralNow).lte(0)) blockers.push('Collateral is zero; LTV and target repayment are undefined.');
  if (collateralStressed!==null && decimal(collateralStressed).lte(0)) blockers.push('Scenario collateral is zero; no finite target LTV can be reviewed.');
  const currentLtv = collateralNow!==null && debt!==null ? ratio(debt,collateralNow) : null;
  const stressedLtv = collateralStressed!==null && debt!==null ? ratio(debt,collateralStressed) : null;
  const threshold = decimal(loan.liquidationThreshold);
  if (threshold.lte(0) || threshold.gte(1)) blockers.push('Invalid liquidation threshold.');
  const thresholdRatio = collateralNow!==null && debt!==null ? ratio(debt,decimal(collateralNow).mul(threshold).toFixed()) : null;
  const currentBreached = currentLtv!==null && decimal(currentLtv).gte(threshold);
  const stressedBreached = stressedLtv!==null && decimal(stressedLtv).gte(threshold);
  if (currentBreached) warnings.push('This observation is already at or above the liquidation threshold. A preview cannot stop liquidation.');
  if (portfolio.mode==='live') warnings.push('Protocol read time is available; the underlying oracle publication time is not exposed by this adapter.');
  return ScenarioResultSchema.parse({ loanId:loan.id,inputPortfolioId:portfolio.id,status:blockers.length?'blocked':warnings.some(w=>w.startsWith('Company coverage'))?'partial':'ready',
    currency:'USDC',basis:'hypothetical-from-protocol',collateralNow,debt,currentLtv,collateralStressed,stressedLtv,modeledReturn,companyWeight,
    unknownWeight:spec.kind==='company'?composition.unknownWeight:'0',declineToThreshold:thresholdRatio===null?null:decimal('1').sub(thresholdRatio).toFixed(),currentBreached,stressedBreached,
    sourceIds:[...new Set([loan.source.id,...(c?[c.source.id]:[]),...(d?[d.source.id]:[]),...(spec.kind==='company'&&composition.source?[composition.source.id]:[])])],
    holdingsSnapshotId:spec.kind==='company'?composition.snapshotId:null,assumptions,warnings,blockers:[...new Set(blockers)] });
}
export function portfolioScenarios(portfolio: Portfolio, spec: ScenarioSpec, context: ReadContext) { return portfolio.loans.map(loan=>scenarioForLoan(portfolio,loan,spec,context)); }
