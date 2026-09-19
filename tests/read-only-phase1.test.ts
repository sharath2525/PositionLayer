import { describe, expect, it } from 'vitest';
import { decimal } from '@/domain/amounts';
import { loanRiskMeter } from '@/domain/loan-risk';
import { buildRepaymentPlan } from '@/domain/repayment';
import { PortfolioResultSchema } from '@/domain/types';
import { workedExamplePortfolio } from '@/services/worked-example';
import { asLive, context } from './fixtures/phase2';

const broad={kind:'broad' as const,decline:'0.15'};

describe('read-only Phase 1 loan risk boundaries',()=>{
  function risk(debt:string,collateral='10000'){
    const portfolio=workedExamplePortfolio();const loan=portfolio.loans[0];
    loan.debtUnscaled=debt;loan.debtValue!.amount=debt;loan.collateralValue!.amount=collateral;
    loan.ltv=collateral==='0'?null:decimal(debt).div(collateral).toFixed();
    return loanRiskMeter(portfolio,loan,context);
  }
  it.each([
    ['6400','within-borrow-range'],
    ['6500','above-borrow-limit'],
    ['7000','above-borrow-limit'],
    ['7800','threshold-reached'],
    ['8000','threshold-reached'],
  ])('classifies debt %s at exact B/T boundaries as %s',(debt,state)=>{
    const result=risk(debt);expect(result.state).toBe(state);
    if(debt==='8000')expect(result.liquidationBoundaryUsed).toBe('1.02564102564102564102564102564102564102564102564102564102564');
  });
  it('calculates current LTV, boundary use, decline buffer and health factor exactly',()=>{
    const result=risk('6500');
    expect(result.currentLtv).toBe('0.65');
    expect(result.liquidationBoundaryUsed).toBe('0.833333333333333333333333333333333333333333333333333333333333');
    expect(result.collateralDeclineToLiquidation).toBe('0.166666666666666666666666666666666666666666666666666666666667');
    expect(result.healthFactor).toBe('1.2');
  });
  it('represents zero debt without infinity and zero collateral as unavailable',()=>{
    const noDebt=risk('0');expect(noDebt.state).toBe('no-debt');expect(noDebt.currentLtv).toBe('0');expect(noDebt.healthFactor).toBeNull();
    const noCollateral=risk('1','0');expect(noCollateral.state).toBe('unavailable');expect(noCollateral.currentLtv).toBeNull();
  });
  it('rejects invalid boundary ordering, missing basis, unsupported and mismatched values',()=>{
    const portfolio=workedExamplePortfolio();const loan=portfolio.loans[0];
    loan.maxBorrowLtv=loan.liquidationThreshold;expect(loanRiskMeter(portfolio,loan,context).state).toBe('unavailable');
    loan.maxBorrowLtv='0.65';loan.collateralValue=null;expect(loanRiskMeter(portfolio,loan,context).state).toBe('unavailable');
    const unsupported=workedExamplePortfolio();unsupported.loans[0].vaultId=999;expect(loanRiskMeter(unsupported,unsupported.loans[0],context).state).toBe('unavailable');
    const mismatch=workedExamplePortfolio();mismatch.loans[0].debtValue!.amount='1';expect(loanRiskMeter(mismatch,mismatch.loans[0],context).state).toBe('unavailable');
  });
  it('fails closed for stale and future live sources',()=>{
    const stale=asLive(workedExamplePortfolio());const staleContext={...context,owner:stale.owner,now:context.now+120001};
    expect(loanRiskMeter(stale,stale.loans[0],staleContext).state).toBe('unavailable');
    const future=asLive(workedExamplePortfolio());expect(loanRiskMeter(future,future.loans[0],{...context,owner:future.owner,now:context.now-6000}).state).toBe('unavailable');
  });
  it('shows a stressed threshold crossing without replacing the current state',()=>{
    const portfolio=workedExamplePortfolio();const result=loanRiskMeter(portfolio,portfolio.loans[0],context,'8000');
    expect(result.state).toBe('above-borrow-limit');expect(result.stressedLtv).toBe('0.8125');expect(result.stressedThresholdCrossed).toBe(true);
  });
  it('retains decimal precision for non-terminating ratios',()=>{
    const portfolio=workedExamplePortfolio();const loan=portfolio.loans[0];loan.debtUnscaled='1';loan.debtValue!.amount='1';loan.collateralValue!.amount='3';loan.ltv='0.333333333333333333333333333333333333333333333333333333333333';
    expect(loanRiskMeter(portfolio,loan,context).currentLtv).toBe(loan.ltv);
  });
});

describe('read-only protection funding',()=>{
  function plan(cash:string,basis:'current'|'stressed'='stressed'){
    const portfolio=workedExamplePortfolio();portfolio.holdings.find(row=>row.instrumentId==='USDC'&&row.scope==='wallet')!.spendableAmount=cash;
    return buildRepaymentPlan(portfolio,portfolio.loans[0].id,broad,'0.55',basis,context);
  }
  it('rounds upward to one USDC base unit and keeps target basis explicit',()=>{
    const portfolio=workedExamplePortfolio();portfolio.loans[0].debtUnscaled='6500.000000001';portfolio.loans[0].debtValue!.amount='6500.000000001';
    const current=buildRepaymentPlan(portfolio,portfolio.loans[0].id,broad,'0.55','current',context);
    expect(current.repaymentBaseUnits).toBe('1000000001');expect(current.repaymentUsdc).toBe('1000.000001');expect(current.targetBasis).toBe('current');
    expect(plan('2000','stressed').repaymentUsdc).toBe('1825');
  });
  it.each([
    ['500','0.27397260273972602739726027397260273972602739726027397260274','1325'],
    ['1825','1','0'],
    ['2000','1','0'],
  ])('reports cash %s with coverage %s and shortfall %s',(cash,coverage,shortfall)=>{
    const result=plan(cash);expect(result.cashCoverage).toBe(coverage);expect(result.shortfallUsdc).toBe(shortfall);
  });
  it('excludes pledged and unsupported balances and does not allocate shared cash twice',()=>{
    const portfolio=workedExamplePortfolio();
    portfolio.holdings.find(row=>row.scope==='deposited')!.instrumentId='USDC';
    portfolio.unsupported.push({mint:'unsupported-usdc-lookalike',accountCount:1,reason:'Unsupported mint'});
    const first=buildRepaymentPlan(portfolio,portfolio.loans[0].id,broad,'0.55','stressed',context);
    const second=buildRepaymentPlan(portfolio,portfolio.loans[0].id,broad,'0.55','stressed',context);
    expect(first.availableUsdc).toBe('2000');expect(second.availableUsdc).toBe('2000');
    expect(first.assumptions.join(' ')).toContain('share the same wallet cash');
  });
});

describe('read-only response boundary',()=>{
  it('strips unknown transaction-shaped material at the portfolio schema boundary',()=>{
    const data={...workedExamplePortfolio(),unsignedTransaction:'forbidden',loans:workedExamplePortfolio().loans.map(loan=>({...loan,transactionBytes:'forbidden'}))};
    const parsed=PortfolioResultSchema.parse({status:'ready',data,signedTransaction:'forbidden'});
    expect(JSON.stringify(parsed)).not.toMatch(/unsignedTransaction|signedTransaction|transactionBytes|forbidden/);
  });
});
