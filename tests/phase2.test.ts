import { describe,it,expect } from 'vitest';
import { decimal, scaledDisplay, toBaseUnits } from '@/domain/amounts';
import { exposure, instrumentComposition } from '@/domain/exposure';
import { scenarioForLoan, portfolioScenarios } from '@/domain/stress';
import { buildRepaymentPlan, validatePlanReview } from '@/domain/repayment';
import { multiplierEvent, priceMatchesEvent, sourceState } from '@/domain/guards';
import { marketSession } from '@/domain/market';
import { referenceValue } from '@/domain/valuation';
import { RepaymentPlanSchema } from '@/domain/planning-types';
import { workedExamplePortfolio } from '@/services/worked-example';
import { context, goldenExposurePortfolio, asLive } from './fixtures/phase2';
import type { ScenarioSpec } from '@/domain/planning-types';

const broad:ScenarioSpec={kind:'broad',decline:'0.15'};
const near=(actual:string|null,expected:string)=>expect(decimal(actual!).sub(expected).abs().lt('0.000000000001')).toBe(true);
const plan=(target='0.55',basis:'current'|'stressed'='stressed')=>{const p=workedExamplePortfolio();return buildRepaymentPlan(p,p.loans[0].id,broad,target,basis,context);};

describe('all BUILD_PLAN Phase 2 financial golden cases',()=>{
  it('current 65%, 15% shock 8500, stressed LTV 76.470588%',()=>{const r=plan().result;expect(r.currentLtv).toBe('0.65');expect(r.collateralStressed).toBe('8500');near(r.stressedLtv,'0.764705882352941176');});
  it('current target requires 1000 USDC, stressed target requires 1825 USDC',()=>{expect(plan('0.55','current').repaymentUsdc).toBe('1000');expect(plan().repaymentUsdc).toBe('1825');expect(plan().repaymentBaseUnits).toBe('1825000000');});
  it('after stressed repayment: debt 4675, current 46.75%, stress 55%',()=>{const p=plan();expect(p.expectedDebtUsdc).toBe('4675');expect(p.expectedCurrentLtv).toBe('0.4675');expect(p.expectedScenarioLtv).toBe('0.55');expect(p.remainingCashUsdc).toBe('175');});
  it('78% threshold distance is 16.666667%',()=>near(plan().result.declineToThreshold,'0.166666666666666667'));
  it('direct 1000 + ETF 5000×8% + ETF 3000×10% = 1700 / 9000',()=>{const e=exposure(goldenExposurePortfolio());const n=e.companies.find(c=>c.id==='NVIDIA')!;expect(n.amountUsd).toBe('1700');expect(e.valuedStockUsd).toBe('9000');near(n.sleeveWeight,'0.188888888888888889');});
  it('20% company fall through 8% ETF weight produces -1.6% loan collateral return',()=>{const p=workedExamplePortfolio();p.etfs=goldenExposurePortfolio().etfs;p.loans[0].vaultId=78;p.loans[0].collateralInstrumentId='SPYx';const r=scenarioForLoan(p,p.loans[0],{kind:'company',companyId:'NVIDIA',change:'-0.2'},context);expect(r.modeledReturn).toBe('-0.016');expect(r.collateralStressed).toBe('9840');});
  it('2-for-1 split preserves 20000 value with unchanged raw amount',()=>{const raw='10000000000';expect(decimal(scaledDisplay(raw,8,'1')).mul('200').toFixed()).toBe('20000');expect(decimal(scaledDisplay(raw,8,'2')).mul('100').toFixed()).toBe('20000');});
  it('repayment reduces cash and debt equally, leaves stock and net equity unchanged',()=>{const p=plan();expect(p.stockQuantityChanges).toBe(false);expect(p.netEquityChangeBeforeFeesUsdc).toBe('0');expect(decimal('10000').add('2000').sub('6500').toFixed()).toBe(decimal('10000').add(p.remainingCashUsdc!).sub(p.expectedDebtUsdc!).toFixed());});
});

describe('per-loan stress and incomplete coverage',()=>{
  it('uses the same composition as exposure and keeps separate loan results',()=>{const p=workedExamplePortfolio();p.etfs=goldenExposurePortfolio().etfs;const second=structuredClone(p.loans[0]);second.id='fixture-spy';second.vaultId=78;second.collateralInstrumentId='SPYx';p.loans.push(second);const r=portfolioScenarios(p,{kind:'company',companyId:'NVIDIA',change:'-0.2'},context);expect(r.map(x=>x.collateralStressed)).toEqual(['8000','9840']);p.etfs[0].constituents[0].weight='0.09';expect(instrumentComposition('SPYx',p.etfs).companies[0].weight).toBe('0.09');expect(portfolioScenarios(p,{kind:'company',companyId:'NVIDIA',change:'-0.2'},context)[1].modeledReturn).toBe('-0.018');});
  it('retains unknown ETF coverage and its fixed-unknown assumption',()=>{const p=workedExamplePortfolio();p.etfs=goldenExposurePortfolio().etfs;p.etfs[0].constituents[1].companyId=null;p.loans[0].vaultId=78;p.loans[0].collateralInstrumentId='SPYx';const r=scenarioForLoan(p,p.loans[0],{kind:'company',companyId:'NVIDIA',change:'-0.2'},context);expect(r.status).toBe('partial');expect(r.unknownWeight).toBe('0.92');expect(r.modeledReturn).toBe('-0.016');expect(r.assumptions.join()).toContain('unknown ETF coverage');});
  it('unavailable QQQ cannot masquerade as a zero company shock; broad shock still works',()=>{const p=workedExamplePortfolio();p.loans[0].vaultId=79;p.loans[0].collateralInstrumentId='QQQx';const r=scenarioForLoan(p,p.loans[0],{kind:'company',companyId:'NVIDIA',change:'-0.2'},context);expect(r.status).toBe('blocked');expect(r.companyWeight).toBeNull();expect(r.collateralStressed).toBeNull();expect(scenarioForLoan(p,p.loans[0],broad,context).collateralStressed).toBe('8500');});
  it('unknown company IDs are rejected',()=>{const p=workedExamplePortfolio();expect(scenarioForLoan(p,p.loans[0],{kind:'company',companyId:'invented',change:'-0.2'},context).status).toBe('blocked');});
  it('DEX or reference prices never replace protocol LTV',()=>{const p=workedExamplePortfolio();p.prices.forEach(x=>{x.value='999999';x.basis='quote';});expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',context).repaymentUsdc).toBe('1825');p.loans[0].collateralValue!.basis='quote';expect(scenarioForLoan(p,p.loans[0],broad,context).collateralNow).toBeNull();});
  it.each(['-0.1','1.01','NaN'])('rejects impossible broad decline %s',decline=>{const p=workedExamplePortfolio();expect(scenarioForLoan(p,p.loans[0],{kind:'broad',decline},context).status).toBe('blocked');});
  it('100% decline produces zero collateral and no finite stressed LTV',()=>{const p=workedExamplePortfolio();const r=scenarioForLoan(p,p.loans[0],{kind:'broad',decline:'1'},context);expect(r.stressedLtv).toBeNull();expect(r.status).toBe('blocked');});
  it('already breached is explicit and threshold distance is signed',()=>{const p=workedExamplePortfolio();p.loans[0].collateralValue!.amount='8000';const r=scenarioForLoan(p,p.loans[0],broad,context);expect(r.currentBreached).toBe(true);expect(decimal(r.declineToThreshold!).lt(0)).toBe(true);});
});

describe('target, funds, precision and review validity',()=>{
  it.each(['0','-1','0.78','0.9','NaN',''])('rejects target %s',t=>expect(plan(t).status).toBe('blocked'));
  it('zero debt and an already-met target need no action',()=>{const p=workedExamplePortfolio();p.loans[0].debtUnscaled='0';p.loans[0].debtValue!.amount='0';expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',context).status).toBe('not-needed');expect(plan('0.7','current').status).toBe('not-needed');});
  it('zero collateral, missing oracle and unsupported position block review',()=>{const p=workedExamplePortfolio();p.loans[0].collateralValue!.amount='0';expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',context).status).toBe('blocked');p.loans[0].collateralValue=null;expect(scenarioForLoan(p,p.loans[0],broad,context).status).toBe('blocked');p.loans[0].vaultId=999;expect(scenarioForLoan(p,p.loans[0],broad,context).blockers.join()).toContain('unsupported');});
  it('uses unfrozen free wallet USDC; exposes negative remainder, coverage and shortfall',()=>{const p=workedExamplePortfolio();p.holdings.find(h=>h.instrumentId==='USDC')!.spendableAmount='500';const r=buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',context);expect(r.status).toBe('ready');expect(r.remainingCashUsdc).toBe('-1325');expect(r.shortfallUsdc).toBe('1325');expect(r.cashCoverage).toBe('0.27397260273972602739726027397260273972602739726027397260274');});
  it('rounds repayment up exactly one USDC base unit when needed',()=>{const p=workedExamplePortfolio();p.loans[0].debtUnscaled='6500.000000001';p.loans[0].debtValue!.amount=p.loans[0].debtUnscaled;const r=buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',context);expect(r.repaymentUsdc).toBe('1000.000001');expect(decimal(r.expectedCurrentLtv!).lte('0.55')).toBe(true);});
  it('captures complete source/snapshot/target provenance and stays non-executable',()=>{const r=RepaymentPlanSchema.parse(plan());expect(r.inputSnapshot.id).toBe('sample-worked-example-v2');expect(r.sources.length).toBeGreaterThan(0);expect(r.targetBasis).toBe('stressed');expect(r.amountUnit).toBe('USDC-base-unit');expect(r.executable).toBe(false);});
  it('invalidates a review when its selected position disappears, without throwing',()=>{const p=workedExamplePortfolio();const r=buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',context);p.loans=[];expect(validatePlanReview(r,p,context).join()).toContain('no longer in this snapshot');});
  it('rejects hypothetical nested values on the live channel',()=>{const p=asLive(workedExamplePortfolio());p.loans[0].debtValue!.source.kind='hypothetical';expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',{...context,owner:p.owner}).blockers.join()).toContain('non-live');});
  it('negative protocol collateral is invalid rather than a negative repayment',()=>{const p=workedExamplePortfolio();p.loans[0].collateralValue!.amount='-1';const r=buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',context);expect(r.status).toBe('blocked');expect(r.repaymentUsdc).toBeNull();});
  it('invalidates on wallet/cluster/mode changes, refresh or expiry',()=>{const p=workedExamplePortfolio();const r=buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','stressed',context);expect(validatePlanReview(r,p,context)).toEqual([]);expect(validatePlanReview(r,p,{...context,owner:'changed'}).length).toBeGreaterThan(0);expect(validatePlanReview(r,p,{...context,cluster:'solana:devnet'}).length).toBeGreaterThan(0);expect(validatePlanReview(r,p,{...context,now:context.now+60000}).join()).toContain('expired');p.id+='refresh';expect(validatePlanReview(r,p,context).join()).toContain('snapshot changed');});
  it('rejects stale/future live observations and foreign numeric sources',()=>{const p=asLive(workedExamplePortfolio());const c={...context,owner:p.owner,now:context.now+120001};expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',c).status).toBe('blocked');expect(sourceState(p.loans[0].source,'live',context.now-6000)).toBe('unverified');p.loans[0].source.kind='sample';expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',{...context,owner:p.owner}).blockers.join()).toContain('non-live');});
  it.each([-1,19,1.5])('rejects unsupported decimals %s',decimals=>expect(()=>toBaseUnits('1',decimals)).toThrow());
});

describe('corporate event guards',()=>{
  it('mismatched split price state invalidates reference value',()=>{const p=workedExamplePortfolio();const h=p.holdings[0];const price=p.prices[0];h.mintState.multiplier='2';expect(referenceValue(h,price)).toBeNull();price.multiplier='2';price.value='62.5';h.displayAmount=decimal(h.unscaledAmount).mul('2').toFixed();expect(referenceValue(h,price)?.amount).toBe('1750');});
  it('scheduled event boundary requires a refreshed stock observation while preserving protocol-basis planning',()=>{const p=workedExamplePortfolio();const h=p.holdings[0];h.mintState.pendingMultiplier='2';h.mintState.effectiveAt=context.now/1000+30;h.mintState.chainTime=context.now/1000;
    expect(multiplierEvent(h.mintState,context.now+29999).status).toBe('scheduled');expect(multiplierEvent(h.mintState,context.now+30000).status).toBe('refresh-required');
    expect(buildRepaymentPlan(p,p.loans[0].id,broad,'0.55','current',{...context,now:context.now+30000}).status).toBe('ready');
  });
  it('rejects a price published before an applied event even if its multiplier field matches',()=>{const p=workedExamplePortfolio();const mint=p.holdings[0].mintState;mint.effectiveAt=context.now/1000+1;mint.chainTime=context.now/1000+2;expect(priceMatchesEvent(p.prices[0],mint)).toBe(false);});
});

describe('reference core market calendar: venue time, never oracle freshness',()=>{
  const at=(iso:string)=>marketSession(Date.parse(iso));
  it('handles weekends and official holidays',()=>{expect(at('2026-09-13T15:00:00Z').status).toBe('closed');expect(at('2026-04-03T15:00:00Z').label).toContain('Good Friday');expect(at('2026-07-03T15:00:00Z').status).toBe('closed');});
  it('handles open/close boundaries and early closes',()=>{expect(at('2026-09-14T13:29:59Z').status).toBe('closed');expect(at('2026-09-14T13:30:00Z').status).toBe('open');expect(at('2026-09-14T20:00:00Z').status).toBe('closed');expect(at('2026-11-27T17:59:59Z').status).toBe('open');expect(at('2026-11-27T18:00:00Z').status).toBe('closed');expect(at('2026-12-24T16:00:00Z').earlyClose).toBe(true);});
  it('handles spring and fall daylight-saving transitions without fixed UTC offsets',()=>{expect(at('2026-03-06T14:30:00Z').status).toBe('open');expect(at('2026-03-09T13:30:00Z').status).toBe('open');expect(at('2026-11-01T12:00:00Z').nextChangeAt).toBe('2026-11-02T14:30:00.000Z');});
  it('does not invent a calendar outside verified coverage',()=>{expect(at('2027-01-04T15:00:00Z').status).toBe('unknown');expect(marketSession(Number.NaN).status).toBe('unknown');});
});
