'use client';
import { useEffect,useRef,useState } from 'react';
import { CircleDollarSign,Clock3,LockKeyhole,RefreshCw,Route as RouteIcon } from 'lucide-react';
import { decimal } from '@/domain/amounts';
import {
  currentLiquidityEvidence,eligibleProtectionStocks,liquidityContextKey,protectionPlanKey,
  type ProtectionLiquidityEvidence,
} from '@/domain/protection-liquidity';
import type { ReadContext } from '@/domain/guards';
import type { RepaymentPlan } from '@/domain/planning-types';
import type { Portfolio } from '@/domain/types';
import { readProtectionLiquidity } from '@/services/browser-liquidity';
import { amount,date,percent,time } from './format';

const stateLabel:Record<ProtectionLiquidityEvidence['state'],string>={
  'not-needed':'Not needed','potentially-covered':'Potentially covered','partially-covered':'Partially covered',
  'no-route':'No route','expired':'Expired','unavailable':'Unavailable',
};
const usdc=(value:string|null|undefined)=>value===null||value===undefined?'—':`${amount(value,2,9)} USDC`;

export function ProtectionLiquidity({portfolio,plan,context}:{portfolio:Portfolio;plan:RepaymentPlan;context:ReadContext}){
  const candidates=eligibleProtectionStocks(portfolio,context);
  const [chosen,setChosen]=useState(candidates[0]?.instrumentId??'');
  const instrumentId=candidates.some(row=>row.instrumentId===chosen)?chosen:(candidates[0]?.instrumentId??'');
  const planKey=protectionPlanKey(plan);const contextKey=liquidityContextKey(plan,instrumentId);
  const [pendingKey,setPendingKey]=useState<string|null>(null);
  const [record,setRecord]=useState<{contextKey:string;evidence:ProtectionLiquidityEvidence}|null>(null);
  const [failure,setFailure]=useState<{contextKey:string;message:string}|null>(null);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>{active.current?.abort();active.current=null;},[contextKey]);
  useEffect(()=>()=>active.current?.abort(),[]);
  const evidence=record?.contextKey===contextKey?currentLiquidityEvidence(record.evidence,planKey,context.now):null;
  const pending=pendingKey===contextKey;const error=failure?.contextKey===contextKey?failure.message:null;
  const shortfall=plan.shortfallUsdc??'0';const needed=decimal(shortfall).gt(0);
  async function check(){
    if(!instrumentId||!needed)return;
    active.current?.abort();const controller=new AbortController();active.current=controller;setPendingKey(contextKey);setFailure(null);
    try{
      const result=await readProtectionLiquidity({mode:portfolio.mode,owner:portfolio.owner,snapshotId:portfolio.id,planKey,loanId:plan.positionId,
        scenario:plan.scenario,target:plan.target,targetBasis:plan.targetBasis,instrumentId},controller.signal);
      if(!controller.signal.aborted)setRecord({contextKey,evidence:result});
    }catch(cause){if(!controller.signal.aborted)setFailure({contextKey,message:cause instanceof Error?cause.message:'Liquidity evidence is unavailable.'});}
    finally{if(active.current===controller){active.current=null;setPendingKey(null);}}
  }
  return <section className="liquidity-check" aria-label="Protection liquidity quote only">
    <div className="liquidity-heading"><div><span className="eyebrow">03 · PROTECTION LIQUIDITY · QUOTE ONLY</span><h3>Could free stock cover the shortfall?</h3></div><CircleDollarSign size={21}/></div>
    <dl className="liquidity-summary"><dt>Funding shortfall</dt><dd>{usdc(plan.shortfallUsdc)}</dd><dt>Current free USDC</dt><dd>{usdc(plan.availableUsdc)}</dd></dl>
    {!needed?<div className="liquidity-state state-good"><strong>Not needed</strong><span>Verified free USDC already covers this selected protection plan.</span></div>:plan.blockers.length?<div className="liquidity-state state-blocked"><strong>Unavailable</strong><span>Resolve the Phase 1 protection-plan blockers before requesting liquidity evidence.</span></div>:!instrumentId?<div className="liquidity-state state-blocked"><strong>Unavailable</strong><span>No verified, fresh, spendable free-wallet stock is eligible. Posted collateral is excluded.</span></div>:<>
      <label className="field liquidity-asset">Free wallet stock<select aria-label="Free stock for liquidity check" value={instrumentId} onChange={event=>setChosen(event.target.value)}>{candidates.map(row=><option key={row.id} value={row.instrumentId}>{row.instrumentId} · {amount(row.spendableAmount,4,9)} display units</option>)}</select></label>
      <button className="button liquidity-button" onClick={check} disabled={pending}>{pending?<><RefreshCw size={15} className="spin"/>Checking Jupiter…</>:<><RouteIcon size={15}/>Check Jupiter liquidity</>}</button>
    </>}
    {error&&<div className="planning-errors" role="alert"><strong>Liquidity check unavailable</strong><p>{error}</p><p>The Phase 1 protection plan remains available above.</p></div>}
    {evidence&&<div className={`liquidity-result state-${evidence.state}`} aria-live="polite">
      <div className="liquidity-state"><strong>{stateLabel[evidence.state]}</strong><span>{evidence.state==='potentially-covered'?'The expected quote output meets this shortfall at the observed size.':evidence.state==='partially-covered'?'The available free stock has a route but does not cover the full shortfall.':evidence.state==='no-route'?'No usable Jupiter route was observed for this exact pair and size.':evidence.state==='expired'?'This observation is retained as dated evidence and is no longer current.':'Quote evidence could not be verified.'}</span></div>
      <dl className="liquidity-details"><dt>Free stock available</dt><dd>{evidence.freeInputDisplay===null?'—':`${amount(evidence.freeInputDisplay,4,9)} ${evidence.inputInstrumentId}`}<small>{evidence.freeInputBaseUnits??'—'} token base units</small></dd><dt>Exact stock input quoted</dt><dd>{evidence.inputDisplay===null?'—':`${amount(evidence.inputDisplay,6,12)} ${evidence.inputInstrumentId}`}<small>{evidence.inputBaseUnits??'—'} token base units</small></dd><dt>Expected Jupiter output</dt><dd>{usdc(evidence.expectedOutputUsdc)}<small>{evidence.expectedOutputBaseUnits??'—'} USDC base units</small></dd><dt>Quote coverage</dt><dd>{percent(evidence.coverageRatio,2)}<small>{usdc(evidence.remainingShortfallUsdc)} remaining</small></dd><dt>Router</dt><dd>{evidence.router??'—'}<small>{evidence.quoteAttemptCount} bounded quote request{evidence.quoteAttemptCount===1?'':'s'}</small></dd><dt>Observed</dt><dd>{date(evidence.observedAt)} · {time(evidence.observedAt)}<small>{evidence.expiresAt?`Expires ${time(evidence.expiresAt)}`:'No current quote expiry'}</small></dd></dl>
      {(evidence.warnings.length>0||evidence.blockers.length>0)&&<ul className="liquidity-notes">{[...evidence.blockers,...evidence.warnings].map((item,index)=><li key={`${index}:${item}`}>{item}</li>)}</ul>}
      <p className="liquidity-source"><Clock3 size={13}/>{evidence.sourceId??'No provider observation'} · {evidence.disclosure}</p>
    </div>}
    <div className="read-only-final liquidity-boundary"><LockKeyhole size={17}/><p><strong>Quote only.</strong> No transaction was created, no signature was requested, and output is not guaranteed execution.</p></div>
  </section>;
}
