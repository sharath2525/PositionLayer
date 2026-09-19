import { describe,expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { byId } from '@/config/instruments';
import { D,toBaseUnits } from '@/domain/amounts';
import { buildRepaymentPlan } from '@/domain/repayment';
import {
  ProtectionLiquidityEvidenceSchema,currentLiquidityEvidence,displayInputAmount,eligibleProtectionStocks,
  liquidityContextKey,protectionPlanKey,
} from '@/domain/protection-liquidity';
import { JupiterApiError } from '@/adapters/jupiter-api/client';
import { parseQuoteOnlyOrderResponse,quoteOnlyOrderPath,type QuoteOnlyOrder } from '@/adapters/jupiter-api/order';
import { checkProtectionLiquidity,type QuoteOnlyReader } from '@/services/protection-liquidity';
import { liquidityExamplePortfolio } from '@/services/worked-example';
import { allowLiquidityRequest,POST } from '@/app/api/protection-liquidity/route';
import { context } from './fixtures/phase2';

const scenario={kind:'broad' as const,decline:'0.15'};
function setup(){
  const portfolio=liquidityExamplePortfolio();
  const plan=buildRepaymentPlan(portfolio,portfolio.loans[0].id,scenario,'0.55','stressed',context);
  const request={mode:'sample' as const,owner:null,snapshotId:portfolio.id,planKey:protectionPlanKey(plan),loanId:plan.positionId,scenario,target:plan.target,targetBasis:plan.targetBasis,instrumentId:'NVDAx'};
  return {portfolio,plan,request};
}
function order(input:string,output:string,expireAt:string|null=null):QuoteOnlyOrder{return {inputMint:byId.NVDAx.mint,outputMint:byId.USDC.mint,inAmount:input,outAmount:output,router:'metis',expireAt,requestId:'provider-secret-id'};}
const proportional:QuoteOnlyReader=async(_id,input)=>order(input,new D(input).mul('125000000').div('100000000').floor().toFixed(0));

describe('quote-only Jupiter boundary',()=>{
  it('builds only the verified stock-to-USDC query and omits wallet/execution parameters',()=>{
    const url=new URL(quoteOnlyOrderPath('NVDAx','123456789'),'https://api.jup.ag');
    expect(url.pathname).toBe('/swap/v2/order');expect(Object.fromEntries(url.searchParams)).toEqual({inputMint:byId.NVDAx.mint,outputMint:byId.USDC.mint,amount:'123456789'});
    expect([...url.searchParams.keys()]).toEqual(['inputMint','outputMint','amount']);
    expect(()=>quoteOnlyOrderPath('USDC','1')).toThrow('verified stock');
  });
  it('rejects execution-shaped and unknown request fields at the server boundary',async()=>{
    const base=setup().request;
    for(const forbidden of ['taker','payer','outputMint','transaction','requestId','signedTransaction']){
      const request=new Request('http://localhost/api/protection-liquidity',{method:'POST',headers:{origin:'http://localhost',host:'localhost','content-type':'application/json'},body:JSON.stringify({...base,[forbidden]:'forbidden'})});
      const response=await POST(request);expect(response.status,forbidden).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });
  it('applies a server rate limit without exposing provider request data',()=>{
    const now=2_000_000;expect(allowLiquidityRequest('phase2-rate-test',now)).toBe(true);
    expect(allowLiquidityRequest('phase2-rate-test',now+3_999)).toBe(false);
    expect(allowLiquidityRequest('phase2-rate-test',now+4_000)).toBe(true);
  });
  it('accepts transaction null and enforces exact response identity and amount',()=>{
    const body={mode:'ultra',inputMint:byId.NVDAx.mint,outputMint:byId.USDC.mint,inAmount:'42',outAmount:'53',router:'metis',transaction:null,requestId:'private'};
    expect(parseQuoteOnlyOrderResponse(body,'NVDAx','42')).toMatchObject({inAmount:'42',outAmount:'53'});
    expect(()=>parseQuoteOnlyOrderResponse({...body,inAmount:'41'},'NVDAx','42')).toThrow('mismatch');
    expect(()=>parseQuoteOnlyOrderResponse({...body,outputMint:byId.SOL.mint},'NVDAx','42')).toThrow('mismatch');
  });
  it.each([{transaction:'bytes'},{transaction:''},{transaction:undefined}])('fails closed for non-null, empty, or missing transaction state: %o',change=>{
    const body={mode:'ultra',inputMint:byId.NVDAx.mint,outputMint:byId.USDC.mint,inAmount:'42',outAmount:'53',router:'metis',requestId:'private',...change};
    expect(()=>parseQuoteOnlyOrderResponse(body,'NVDAx','42')).toThrow();
  });
  it('rejects malformed output and supports exact 6, 8, and 9 decimal base units',()=>{
    expect(()=>parseQuoteOnlyOrderResponse({transaction:null},'NVDAx','1')).toThrow();
    expect(toBaseUnits('1.234567',6)).toBe('1234567');expect(toBaseUnits('1.23456789',8)).toBe('123456789');expect(toBaseUnits('1.234567891',9)).toBe('1234567891');
  });
});

describe('protection liquidity calculation',()=>{
  it('applies the Token-2022 display multiplier once while quoting exact raw balance units',()=>{
    const {portfolio,plan}=setup();const holding=portfolio.holdings.find(row=>row.id==='sample:wallet:NVDAx')!;
    holding.mintState.multiplier='2';holding.displayAmount='28';holding.spendableAmount='28';
    const eligible=eligibleProtectionStocks(portfolio,context);expect(eligible).toContain(holding);
    expect(displayInputAmount('100000000',holding)).toBe('2');
    expect(liquidityContextKey(plan,'NVDAx')).toContain('spendableRawAmount');
  });
  it('returns potentially-covered evidence without changing current cash or exposing request IDs',async()=>{
    const {portfolio,request}=setup();const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,proportional);
    expect(result.state).toBe('potentially-covered');expect(new D(result.expectedOutputBaseUnits!).gte(result.shortfallBaseUnits)).toBe(true);
    expect(new D(result.inputBaseUnits!).lte(result.freeInputBaseUnits!)).toBe(true);expect(result.currentCashAfterQuoteUsdc).toBe(result.currentCashUsdc);
    expect(result.transactionCreated).toBe(false);expect(JSON.stringify(result)).not.toContain('provider-secret-id');expect(result.quoteAttemptCount).toBeLessThanOrEqual(3);
  });
  it('returns partial evidence only after respecting the verified free-wallet maximum',async()=>{
    const {portfolio,request}=setup();const holding=portfolio.holdings.find(row=>row.id==='sample:wallet:NVDAx')!;
    holding.rawAmount='100000000';holding.spendableRawAmount='100000000';holding.unscaledAmount='1';holding.displayAmount='1';holding.spendableAmount='1';
    const plan=buildRepaymentPlan(portfolio,request.loanId,scenario,'0.55','stressed',context);request.planKey=protectionPlanKey(plan);
    const seen:string[]=[];const reader:QuoteOnlyReader=async(id,input)=>{seen.push(input);return proportional(id,input);};
    const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);
    expect(result.state).toBe('partially-covered');expect(result.inputBaseUnits).toBe('100000000');expect(seen.every(value=>BigInt(value)<=100000000n)).toBe(true);
  });
  it('never treats pledged collateral as quote inventory',async()=>{
    const {portfolio,request}=setup();portfolio.holdings=portfolio.holdings.filter(row=>row.scope==='deposited'||row.instrumentId==='USDC');
    const plan=buildRepaymentPlan(portfolio,request.loanId,scenario,'0.55','stressed',context);request.planKey=protectionPlanKey(plan);
    const reader=vi.fn(proportional);const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);
    expect(result.state).toBe('unavailable');expect(result.blockers.join(' ')).toContain('Posted collateral');expect(reader).not.toHaveBeenCalled();
  });
  it('returns not-needed without a provider request when current cash covers the plan',async()=>{
    const {portfolio,request}=setup();const cash=portfolio.holdings.find(row=>row.instrumentId==='USDC'&&row.scope==='wallet')!;
    cash.rawAmount='2000000000';cash.spendableRawAmount='2000000000';cash.unscaledAmount='2000';cash.displayAmount='2000';cash.spendableAmount='2000';
    const plan=buildRepaymentPlan(portfolio,request.loanId,scenario,'0.55','stressed',context);request.planKey=protectionPlanKey(plan);
    const reader=vi.fn(proportional);const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);
    expect(result.state).toBe('not-needed');expect(result.shortfallUsdc).toBe('0');expect(reader).not.toHaveBeenCalled();
  });
  it('reports no-route and keeps the Phase 1 plan intact',async()=>{
    const {portfolio,plan,request}=setup();const reader:QuoteOnlyReader=async()=>{throw new JupiterApiError('http',400,'bad request');};
    const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);
    expect(result.state).toBe('no-route');expect(plan.repaymentUsdc).toBe('1825');expect(plan.shortfallUsdc).toBe('1325');
  });
  it.each([
    ['timeout',null],['aborted',null],['rate-limited',429],['http',401],['http',500],['malformed',200],
  ] as const)('isolates provider %s/%s failures from Phase 1',async(kind,status)=>{
    const {portfolio,plan,request}=setup();const reader:QuoteOnlyReader=async()=>{throw new JupiterApiError(kind,status,'failed');};
    const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);
    expect(result.state).toBe('unavailable');expect(result.blockers.length).toBeGreaterThan(0);expect(plan.status).toBe('ready');
  });
  it('marks provider-expired evidence expired and invalidates changed plan context',async()=>{
    const {portfolio,plan,request}=setup();const reader:QuoteOnlyReader=async(_id,input)=>order(input,'2000000000',new Date(context.now-1).toISOString());
    const result=await checkProtectionLiquidity(portfolio,request,undefined,context.now,reader);expect(result.state).toBe('expired');
    expect(currentLiquidityEvidence(result,protectionPlanKey(plan)+'changed',context.now)).toBeNull();
    const current={...result,state:'potentially-covered' as const,expiresAt:new Date(context.now+1).toISOString()};
    expect(currentLiquidityEvidence(ProtectionLiquidityEvidenceSchema.parse(current),protectionPlanKey(plan),context.now+2)?.state).toBe('expired');
  });
  it('expires at a scheduled multiplier boundary but not at an already-applied event',async()=>{
    const scheduled=setup();const scheduledMint=scheduled.portfolio.holdings.find(row=>row.id==='sample:wallet:NVDAx')!.mintState;
    scheduledMint.pendingMultiplier='2';scheduledMint.effectiveAt=Math.floor(context.now/1000)+10;scheduledMint.chainTime=Math.floor(context.now/1000);
    const scheduledPlan=buildRepaymentPlan(scheduled.portfolio,scheduled.request.loanId,scenario,'0.55','stressed',context);scheduled.request.planKey=protectionPlanKey(scheduledPlan);
    const before=await checkProtectionLiquidity(scheduled.portfolio,scheduled.request,undefined,context.now,proportional);
    expect(before.expiresAt).toBe(new Date(scheduledMint.effectiveAt*1000).toISOString());

    const applied=setup();const appliedMint=applied.portfolio.holdings.find(row=>row.id==='sample:wallet:NVDAx')!.mintState;
    appliedMint.pendingMultiplier=null;appliedMint.effectiveAt=Math.floor(context.now/1000)-10;appliedMint.chainTime=Math.floor(context.now/1000);
    const appliedPlan=buildRepaymentPlan(applied.portfolio,applied.request.loanId,scenario,'0.55','stressed',context);applied.request.planKey=protectionPlanKey(appliedPlan);
    const after=await checkProtectionLiquidity(applied.portfolio,applied.request,undefined,context.now,proportional);
    expect(after.state).toBe('potentially-covered');expect(Date.parse(after.expiresAt!)).toBe(context.now+30_000);
  });
  it('invalidates wallet, loan, scenario, target, balance, and snapshot changes through bound keys',()=>{
    const {portfolio,plan}=setup();const original=liquidityContextKey(plan,'NVDAx');
    for(const mutate of [
      (p:typeof portfolio)=>{p.owner='changed';},(p:typeof portfolio)=>{p.loans[0].id+='changed';},
      (p:typeof portfolio)=>{p.holdings[0].spendableRawAmount='1';},(p:typeof portfolio)=>{p.id+='refresh';},
    ]){const changed=structuredClone(portfolio);mutate(changed);const next=buildRepaymentPlan(changed,changed.loans[0].id,scenario,'0.55','stressed',{...context,owner:changed.owner});expect(liquidityContextKey(next,'NVDAx')).not.toBe(original);}
    const changedScenario=buildRepaymentPlan(portfolio,plan.positionId,{kind:'broad',decline:'0.2'},'0.55','stressed',context);expect(liquidityContextKey(changedScenario,'NVDAx')).not.toBe(original);
    const changedTarget=buildRepaymentPlan(portfolio,plan.positionId,scenario,'0.54','stressed',context);expect(liquidityContextKey(changedTarget,'NVDAx')).not.toBe(original);
  });
});
