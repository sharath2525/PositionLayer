import 'server-only';
import { byId } from '@/config/instruments';
import { fromBaseUnits, toBaseUnits, D } from '@/domain/amounts';
import { buildRepaymentPlan } from '@/domain/repayment';
import {
  MAX_QUOTE_ATTEMPTS,ProtectionLiquidityEvidenceSchema,displayInputAmount,eligibleProtectionStocks,
  initialQuoteInputBaseUnits,nextQuoteInputBaseUnits,parseQuoteExpiry,protectionPlanKey,quoteCoverage,
  type ProtectionLiquidityEvidence,type ProtectionLiquidityRequest,
} from '@/domain/protection-liquidity';
import type { Portfolio } from '@/domain/types';
import { JupiterApiError } from '@/adapters/jupiter-api/client';
import { readQuoteOnlyOrder,type QuoteOnlyOrder } from '@/adapters/jupiter-api/order';

export type QuoteOnlyReader=(instrumentId:string,inputBaseUnits:string,signal?:AbortSignal)=>Promise<QuoteOnlyOrder>;

function baseEvidence(request:ProtectionLiquidityRequest,plan:ReturnType<typeof buildRepaymentPlan>,now:number):ProtectionLiquidityEvidence{
  const shortfall=plan.shortfallUsdc??'0';const currentCash=plan.availableUsdc;
  return ProtectionLiquidityEvidenceSchema.parse({
    schemaVersion:1,state:'unavailable',mode:request.mode,snapshotId:request.snapshotId,planKey:request.planKey,loanId:request.loanId,
    inputInstrumentId:null,inputMint:null,outputMint:byId.USDC.mint,tokenProgram:null,decimals:null,multiplier:null,
    freeInputBaseUnits:null,freeInputDisplay:null,inputBaseUnits:null,inputDisplay:null,
    shortfallBaseUnits:toBaseUnits(shortfall,6),shortfallUsdc:shortfall,expectedOutputBaseUnits:null,expectedOutputUsdc:null,
    coverageRatio:null,remainingShortfallUsdc:shortfall,currentCashUsdc:currentCash,currentCashAfterQuoteUsdc:currentCash,
    router:null,observedAt:new Date(now).toISOString(),expiresAt:null,providerExpiryAt:null,sourceId:null,quoteAttemptCount:0,transactionCreated:false,
    warnings:[],blockers:[],disclosure:'The requested stock-to-USDC pair and exact size are disclosed to Jupiter for this quote check.',
  });
}

function providerMessage(error:unknown):{state:'no-route'|'unavailable';message:string}{
  if(error instanceof JupiterApiError){
    if(error.kind==='aborted')return {state:'unavailable',message:'The Jupiter quote check was cancelled because its inputs changed.'};
    if(error.kind==='timeout')return {state:'unavailable',message:'Jupiter did not return a quote before the timeout.'};
    if(error.kind==='rate-limited')return {state:'unavailable',message:'Jupiter rate-limited this quote check. Wait before trying again.'};
    if(error.kind==='http'&&(error.status===400||error.status===404))return {state:'no-route',message:'Jupiter returned no usable route for this exact pair and size.'};
    if(error.kind==='http')return {state:'unavailable',message:`Jupiter quote service returned HTTP ${error.status}.`};
    return {state:'unavailable',message:'Jupiter returned malformed quote data.'};
  }
  return {state:'unavailable',message:error instanceof Error?error.message:'Jupiter quote evidence is unavailable.'};
}

export async function checkProtectionLiquidity(portfolio:Portfolio,request:ProtectionLiquidityRequest,signal?:AbortSignal,now=Date.now(),reader:QuoteOnlyReader=readQuoteOnlyOrder):Promise<ProtectionLiquidityEvidence>{
  let plan:ReturnType<typeof buildRepaymentPlan>;
  try { plan=buildRepaymentPlan(portfolio,request.loanId,request.scenario,request.target,request.targetBasis,{owner:portfolio.owner,cluster:portfolio.cluster,now}); }
  catch { throw Error('The selected protection plan is no longer available.'); }
  let evidence=baseEvidence(request,plan,now);
  if(protectionPlanKey(plan)!==request.planKey)return ProtectionLiquidityEvidenceSchema.parse({...evidence,blockers:['The protection plan changed during validation. Review the refreshed values before checking liquidity.']});
  if(plan.blockers.length)return ProtectionLiquidityEvidenceSchema.parse({...evidence,blockers:['The Phase 1 protection plan is blocked.',...plan.blockers]});
  if(plan.shortfallUsdc===null)return ProtectionLiquidityEvidenceSchema.parse({...evidence,blockers:['The protection shortfall is unavailable.']});
  if(new D(plan.shortfallUsdc).isZero())return ProtectionLiquidityEvidenceSchema.parse({...evidence,state:'not-needed',remainingShortfallUsdc:'0',coverageRatio:'1',blockers:[],warnings:['Existing verified wallet USDC already covers this protection plan; no stock quote was requested.']});
  const holding=eligibleProtectionStocks(portfolio,{owner:portfolio.owner,cluster:portfolio.cluster,now}).find(row=>row.instrumentId===request.instrumentId);
  if(!holding)return ProtectionLiquidityEvidenceSchema.parse({...evidence,inputInstrumentId:request.instrumentId,blockers:['The selected asset is not verified, fresh, spendable free-wallet stock. Posted collateral is never eligible.']});
  const instrument=byId[holding.instrumentId];
  const quoteEventAt=holding.mintState.pendingMultiplier!==null?holding.mintState.effectiveAt:null;
  evidence=ProtectionLiquidityEvidenceSchema.parse({...evidence,inputInstrumentId:instrument.id,inputMint:instrument.mint,tokenProgram:instrument.tokenProgram,decimals:instrument.decimals,
    multiplier:holding.mintState.multiplier,freeInputBaseUnits:holding.spendableRawAmount,freeInputDisplay:displayInputAmount(holding.spendableRawAmount,holding)});
  const shortfallBaseUnits=evidence.shortfallBaseUnits;const maximum=holding.spendableRawAmount;
  let input=initialQuoteInputBaseUnits(portfolio,plan,holding,{owner:portfolio.owner,cluster:portfolio.cluster,now});
  const observations:QuoteOnlyOrder[]=[];const warnings:string[]=[];
  for(let attempt=0;attempt<MAX_QUOTE_ATTEMPTS;attempt++){
    if(signal?.aborted)throw new JupiterApiError('aborted',null,'Jupiter request was cancelled.');
    try { observations.push(await reader(instrument.id,input,signal)); }
    catch(error){
      const failure=providerMessage(error);
      if(!observations.length){
        const expiry=failure.state==='no-route'?parseQuoteExpiry(null,now,quoteEventAt):{expiresAt:null,providerExpiryAt:null};
        return ProtectionLiquidityEvidenceSchema.parse({...evidence,state:failure.state,inputBaseUnits:input,inputDisplay:displayInputAmount(input,holding),
          quoteAttemptCount:attempt+1,expiresAt:expiry.expiresAt,providerExpiryAt:expiry.providerExpiryAt,blockers:failure.state==='unavailable'?[failure.message]:[],warnings:failure.state==='no-route'?[failure.message]:[]});
      }
      warnings.push(`A bounded refinement stopped early: ${failure.message}`);break;
    }
    const current=observations.at(-1)!;
    let next=nextQuoteInputBaseUnits(current.inAmount,current.outAmount,shortfallBaseUnits,maximum);
    if(attempt===MAX_QUOTE_ATTEMPTS-2&&new D(current.outAmount).lt(shortfallBaseUnits)&&new D(current.inAmount).lt(maximum))next=maximum;
    if(!next||observations.some(row=>row.inAmount===next))break;
    input=next;
  }
  const covered=observations.filter(row=>new D(row.outAmount).gte(shortfallBaseUnits)).sort((a,b)=>new D(a.inAmount).cmp(b.inAmount));
  const selected=covered[0]||[...observations].sort((a,b)=>new D(b.outAmount).cmp(a.outAmount))[0];
  const coverage=quoteCoverage(selected.outAmount,shortfallBaseUnits);const expiry=parseQuoteExpiry(selected.expireAt,now,quoteEventAt);
  const expired=now>=Date.parse(expiry.expiresAt);
  if(holding.mintState.pendingMultiplier!==null)warnings.push('A multiplier update is scheduled; this quote expires no later than the observed event boundary.');
  warnings.push('Expected output is a point-in-time Jupiter quote. It is not added to current wallet cash.');
  return ProtectionLiquidityEvidenceSchema.parse({...evidence,state:expired?'expired':covered.length?'potentially-covered':'partially-covered',
    inputBaseUnits:selected.inAmount,inputDisplay:displayInputAmount(selected.inAmount,holding),expectedOutputBaseUnits:selected.outAmount,
    expectedOutputUsdc:fromBaseUnits(selected.outAmount,6),coverageRatio:coverage.coverage,remainingShortfallUsdc:coverage.remaining,
    router:selected.router,expiresAt:expiry.expiresAt,providerExpiryAt:expiry.providerExpiryAt,sourceId:'jupiter-swap-v2-order-quote-only',
    quoteAttemptCount:observations.length,warnings,blockers:[]});
}
