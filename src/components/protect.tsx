'use client';
import { useMemo, useState } from 'react';
import { FlaskConical, LockKeyhole, Shield, SlidersHorizontal, Wallet } from 'lucide-react';
import { decimal } from '@/domain/amounts';
import { loanRiskMeter } from '@/domain/loan-risk';
import { portfolioScenarios } from '@/domain/stress';
import { buildRepaymentPlan } from '@/domain/repayment';
import { ScenarioSpecSchema, type ScenarioSpec } from '@/domain/planning-types';
import type { Portfolio } from '@/domain/types';
import type { ReadContext } from '@/domain/guards';
import { companyNames } from '@/config/companies';
import { liquidityExamplePortfolio } from '@/services/worked-example';
import { amount, date, percent, time } from './format';
import { LoanRiskMeter } from './loan-risk-meter';
import { ProtectionLiquidity } from './protection-liquidity';
import { IdentityIcon } from './asset-logo';

const fraction=(value:string)=>{try{return decimal(value).div(100).toFixed();}catch{return 'invalid';}};
const cash=(value:string|null|undefined)=>value==null?'—':`${amount(value,2,9)} USDC`;
const age=(observedAt:string,now:number,mode:Portfolio['mode'])=>mode==='sample'?'Fixture':`${Math.max(0,Math.floor((now-Date.parse(observedAt))/1000))}s old`;

export function Protect({data,context,initialLoanId}:{data:Portfolio;context:ReadContext;initialLoanId?:string|null}) {
  const example=useMemo(()=>liquidityExamplePortfolio(),[]);
  const [useExample,setExample]=useState(false);
  const portfolio=useExample&&data.mode==='sample'?example:data;
  const [loanId,setLoan]=useState(initialLoanId||portfolio.loans[0]?.id||'');
  const [kind,setKind]=useState<'broad'|'company'>('broad');
  const [decline,setDecline]=useState('15');
  const [companyMove,setMove]=useState('-20');
  const [companyId,setCompany]=useState('NVIDIA');
  const [target,setTarget]=useState('55');
  const [basis,setBasis]=useState<'current'|'stressed'>('stressed');
  const selected=portfolio.loans.find(loan=>loan.id===loanId)||portfolio.loans[0];
  const specification:ScenarioSpec=kind==='broad'?{kind,decline:fraction(decline)}:{kind,companyId,change:fraction(companyMove)};
  const parsed=ScenarioSpecSchema.safeParse(specification);
  const results=parsed.success?portfolioScenarios(portfolio,parsed.data,context):[];
  const plan=selected&&parsed.success?buildRepaymentPlan(portfolio,selected.id,parsed.data,fraction(target),basis,context):null;
  const risk=selected?loanRiskMeter(portfolio,selected,context,plan?.result.collateralStressed):null;
  const companyOptions=[...new Map([['NVIDIA','NVIDIA'],['TESLA','Tesla'],...portfolio.etfs.flatMap(etf=>etf.constituents.filter(row=>row.companyId).map(row=>[row.companyId!,companyNames[row.companyId!]||row.name]))].map(([id,name])=>[id,{id,name}])).values()];
  if(!selected)return <section className="panel state-card"><Shield size={30}/><h2>No supported loan to stress</h2><p>Read a supported Jupiter Lend position to calculate protocol risk and a protection plan.</p></section>;
  return <div className="protect-view">
    <div className="planning-banner"><span><Shield size={17}/><strong>Current risk · READ ONLY</strong><small>Evidence and planning only</small></span>{data.mode==='sample'&&<button className="text-button" onClick={()=>setExample(value=>!value)}><FlaskConical size={15}/>{useExample?'Return to sample portfolio':'Use worked example'}</button>}</div>
    {useExample&&<div className="notice example-note"><FlaskConical size={18}/><span><strong>Illustrative worked example.</strong> Collateral 10,000 USDC; debt 6,500 USDC; free cash 500 USDC; liquidation threshold 78%. These are fixtures, not current vault parameters.</span></div>}
    <section className="panel protect-risk-card"><div className="panel-heading"><div><span className="eyebrow">CURRENT + STRESSED RISK</span><h2 className="identity-heading"><span className="paired-icons"><IdentityIcon id={selected.collateralInstrumentId}/><IdentityIcon id="USDC"/></span>{selected.collateralInstrumentId} / USDC</h2><p>Vault {selected.vaultId} · position {selected.positionId} · source {age(selected.source.observedAt,context.now,portfolio.mode)}</p></div><Shield size={21}/></div>{risk&&<LoanRiskMeter risk={risk} showStress/>}<p className="hypothetical-label"><FlaskConical size={14}/>HYPOTHETICAL stressed marker. Debt stays fixed at the observed snapshot.</p></section>
    <div className="protect-grid"><section className="panel scenario-panel"><div className="panel-heading"><div><span className="eyebrow">01 · CHOOSE A STOCK SHOCK · HYPOTHETICAL</span><h2>What if the market moves?</h2><p>Each position is modeled independently.</p></div><SlidersHorizontal size={20}/></div>
      <div className="scenario-controls"><label className="field">Loan to review<select aria-label="Loan to review" value={selected.id} onChange={event=>setLoan(event.target.value)}>{portfolio.loans.map(loan=><option key={loan.id} value={loan.id}>{loan.collateralInstrumentId} / USDC · vault {loan.vaultId} · position {loan.positionId}</option>)}</select></label>
        <div className="segmented" aria-label="Scenario type"><button aria-pressed={kind==='broad'} onClick={()=>setKind('broad')}>Broad collateral decline</button><button aria-pressed={kind==='company'} onClick={()=>setKind('company')}>Company move</button></div>
        {kind==='broad'?<div className="shock-control"><label className="field">Collateral decline (%)<input aria-label="Collateral decline (%)" type="number" min="0" max="100" step="1" value={decline} onChange={event=>setDecline(event.target.value)}/></label><input aria-label="Collateral decline slider" type="range" min="0" max="100" value={decline||0} onChange={event=>setDecline(event.target.value)}/><p>Applies the same decline to this loan’s protocol-oracle collateral value.</p></div>:<div className="company-controls"><label className="field">Company<select aria-label="Shock company" value={companyId} onChange={event=>setCompany(event.target.value)}>{companyOptions.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label className="field">Company move (%)<input aria-label="Company move (%)" type="number" min="-100" max="100" value={companyMove} onChange={event=>setMove(event.target.value)}/></label><p>Only verified direct and dated ETF look-through weights move. Unknown coverage stays fixed.</p></div>}
      </div>
      {!parsed.success&&<div role="alert" className="notice error">Enter a valid broad decline from 0–100%, or company move from -100% to +100%.</div>}
      {plan&&<div className="scenario-comparison"><div><span>Protocol now</span><strong>{cash(plan.result.collateralNow)}</strong><small>{percent(plan.result.currentLtv)} LTV</small></div><div aria-hidden="true">→</div><div className={plan.result.stressedBreached?'scenario-breached':''}><span>Hypothetical stress</span><strong>{cash(plan.result.collateralStressed)}</strong><small>{percent(plan.result.stressedLtv)} LTV{plan.result.stressedBreached?' · threshold reached':''}</small></div></div>}
      <div className="scenario-facts"><span>Accrued debt<strong>{cash(selected.debtUnscaled)}</strong></span><span>Maximum-borrow LTV<strong>{percent(selected.maxBorrowLtv)}</strong></span><span>Liquidation threshold<strong>{percent(selected.liquidationThreshold)}</strong></span></div>
    </section>
    <section className="panel target-panel"><div className="panel-heading"><div><span className="eyebrow">02 · PROTECTION PLAN · READ ONLY</span><h2>Choose a target LTV.</h2></div><Wallet size={20}/></div><div className="target-body"><label className="field">Target LTV (%)<div className="target-input"><input aria-label="Target LTV (%)" type="number" min="0.1" max="99.9" step="0.1" value={target} onChange={event=>setTarget(event.target.value)}/><span>%</span></div></label><p className="muted">Must be greater than 0% and strictly below {percent(selected.liquidationThreshold)}.</p>
      <fieldset className="target-basis"><legend>Calculation basis</legend><label><input type="radio" name="target-basis" checked={basis==='current'} onChange={()=>setBasis('current')}/><span><strong>Current protocol valuation</strong><small>Target the observed collateral value.</small></span></label><label><input type="radio" name="target-basis" checked={basis==='stressed'} onChange={()=>setBasis('stressed')}/><span><strong>Hypothetical stressed valuation</strong><small>Target the modeled post-shock value.</small></span></label></fieldset>
      <div className="repayment-estimate"><span>Estimated USDC repayment</span><strong data-testid="repayment-estimate">{cash(plan?.repaymentUsdc)}</strong><p>{basis==='current'?'Current protocol basis':'Hypothetical stressed basis'}</p><small>Rounded upward to 0.000001 USDC</small></div>
      <dl className="funding-summary"><dt>Verified spendable wallet USDC</dt><dd>{cash(plan?.availableUsdc)}</dd><dt>Cash coverage</dt><dd>{percent(plan?.cashCoverage,2)}</dd><dt>Funding shortfall</dt><dd className={plan?.shortfallUsdc&&decimal(plan.shortfallUsdc).gt(0)?'negative':''}>{cash(plan?.shortfallUsdc)}</dd><dt>Expected debt after plan</dt><dd>{cash(plan?.expectedDebtUsdc)}</dd></dl>
      {plan&&plan.blockers.length>0&&<div role="alert" className="planning-errors"><strong>Protection plan unavailable</strong><ul>{plan.blockers.map(blocker=><li key={blocker}>{blocker}</li>)}</ul></div>}
      {plan&&<ProtectionLiquidity portfolio={portfolio} plan={plan} context={context}/>}
      <div className="read-only-final"><LockKeyhole size={17}/><p><strong>Protection plan only.</strong> No transaction was created, no wallet signature was requested, and no balance changed.</p></div>
    </div></section></div>
    <section className="panel per-loan-panel"><div className="panel-heading"><div><h2>Scenario across your loans</h2><p>Each result is separate. Every plan references the same wallet cash without counting it more than once.</p></div></div><div className="table-scroll"><table><thead><tr><th>Position</th><th>Protocol LTV now</th><th>Hypothetical LTV</th><th>Modeled return</th><th>Coverage</th></tr></thead><tbody>{results.map(result=>{const instrumentId=portfolio.loans.find(loan=>loan.id===result.loanId)?.collateralInstrumentId||'';return <tr key={result.loanId}><td><span className="table-identity"><IdentityIcon id={instrumentId}/><span>{instrumentId}<small>{result.loanId}</small></span></span></td><td>{percent(result.currentLtv)}</td><td className={result.stressedBreached?'negative':''}>{percent(result.stressedLtv)}</td><td>{percent(result.modeledReturn,4)}</td><td>{result.status==='blocked'?'Unavailable':result.status==='partial'?'Partial':'Modeled'}{result.blockers.length>0&&<small>{result.blockers[0]}</small>}</td></tr>})}</tbody></table></div></section>
    {plan&&<details className="panel planning-assumptions"><summary>Technical evidence, formulas, assumptions &amp; sources</summary><dl><dt>Collateral accounting</dt><dd>{selected.collateralAccountingRaw} / 10⁹</dd><dt>Debt accounting</dt><dd>{selected.debtAccountingRaw} / 10⁹ USDC</dd><dt>Liquidation penalty</dt><dd>{percent(selected.liquidationPenalty)}</dd><dt>Observed</dt><dd>{date(selected.source.observedAt)} · {time(selected.source.observedAt)}</dd><dt>Slot range</dt><dd>{selected.source.slot===null?'Not supplied':`${selected.source.slot}–${selected.source.endSlot}`}</dd></dl><p>currentLtv = D / C · boundary used = currentLtv / T · decline buffer = 1 − currentLtv / T · health factor = T / currentLtv · repayment = max(0, D − target × selected collateral).</p><ul>{[...plan.assumptions,...plan.warnings].map((item,index)=><li key={index}>{item}</li>)}</ul><p>Source IDs: {plan.sources.map(source=>source.id).join(', ')}</p></details>}
  </div>;
}
