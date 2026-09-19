'use client';

import { ArrowDownLeft, ArrowRight, ChartNoAxesCombined, Check, Fingerprint, Layers3, Shield, Wallet } from 'lucide-react';
import { decimal } from '@/domain/amounts';
import { exposure } from '@/domain/exposure';
import { highestRiskLoan } from '@/domain/loan-risk';
import { importantStockPositions, verifiedStockEarnPositions } from '@/domain/portfolio';
import { summary } from '@/domain/valuation';
import type { Portfolio } from '@/domain/types';
import type { ReadContext } from '@/domain/guards';
import { amount, date, percent, usdAmount } from '@/components/format';
import { AssetIcon, BorrowPositions, EarnPositions, StockPositionsTable } from '@/components/portfolio/portfolio-sections';

function Metric({ label, value, detail, icon, accent }: { label: string; value: string; detail: string; icon: React.ReactNode; accent?: boolean }) {
  return <div className={`panel metric ${accent ? 'accent' : ''}`}><div>{label}{icon}</div><strong>{value}</strong><span>{detail}</span></div>;
}

export function OverviewView({ data, context, onPortfolio, onExposure, onStress }: { data: Portfolio; context: ReadContext; onPortfolio: () => void; onExposure: () => void; onStress: (loanId:string) => void }) {
  const totals = summary(data);
  const lookthrough = exposure(data);
  const important = importantStockPositions(data);
  const stockEarn = verifiedStockEarnPositions(data).map(row => row.position);
  const highestRisk = highestRiskLoan(data, context);
  return <>
    <div className="metrics-grid"><Metric label="Covered portfolio value" value={usdAmount(totals.assetsReference)} detail={`${totals.valuedHoldings} of ${totals.totalHoldings} balances and deposits valued · reference USD`} icon={<ChartNoAxesCombined size={16}/>}/><Metric label="Free wallet USDC" value={`${totals.freeUsdc === null ? 'Unavailable' : amount(totals.freeUsdc)} USDC`} detail="Unfrozen, spendable wallet balance" icon={<Wallet size={16}/>}/><Metric label="Outstanding debt" value={`${totals.debtUsdc === null ? 'Unavailable' : amount(totals.debtUsdc)} USDC`} detail={`${data.loans.length} supported loan${data.loans.length===1?'':'s'} · ${data.loanRead==='ready'?'read complete':'coverage incomplete'}`} icon={<ArrowDownLeft size={17}/>}/><Metric label={totals.complete ? 'Net equity' : 'Partial net equity'} value={usdAmount(totals.equityReference)} detail="Covered reference assets minus protocol debt" icon={<Shield size={16}/>} accent/></div>
    <div className="overview-grid"><section className="panel holdings-panel important-holdings"><div className="panel-heading"><div><h2>Important stock &amp; ETF holdings<span className="count">{important.length}</span></h2><p>Top verified wallet and posted positions by reference value.</p></div><span className="small-label">TOP {Math.min(5, important.length)} · REFERENCE USD</span></div><StockPositionsTable rows={important}/><div className="panel-bottom split-bottom"><span><Fingerprint size={14}/>Unvalued positions remain visible and are never treated as zero.</span><button className="text-button" onClick={onPortfolio}>View portfolio<ArrowRight size={14}/></button></div></section>
      <section className="panel lookthrough-card"><div className="mini-eyebrow"><Layers3 size={16}/>TOP COMPANY EXPOSURES</div><h2>Look beyond<br/>the token.</h2><p>Direct, Earn, posted, and ETF routes combine into company exposure.</p><div className="mini-companies">{lookthrough.companies.slice(0,3).map(c=><div key={c.id}><AssetIcon id={c.ticker} label={c.name} kind="company"/><div><strong>{c.name}</strong><span>{c.contributions.some(row=>row.scope==='earn')?'Includes Earn':decimal(c.directUsd).gt(0)&&decimal(c.etfUsd).gt(0)?'Direct + ETF exposure':'ETF exposure'}</span></div><strong>{percent(c.sleeveWeight)}</strong></div>)}{lookthrough.companies.length===0&&<p className="muted">Company values will appear when reference prices are verified.</p>}</div><button className="button exposure-cta" onClick={onExposure}>Explore exposure<ArrowRight size={16}/></button><span className="sleeve-caption">Share of the covered stock sleeve</span></section></div>
    {stockEarn.length>0&&<><EarnPositions positions={stockEarn} heading="Stock & ETF holdings in Earn" description="Only exact underlying mints matched to the trusted stock/ETF registry." overview/><div className="overview-section-action"><button className="text-button" onClick={onPortfolio}>View all Earn positions in Portfolio<ArrowRight size={14}/></button></div></>}
    <section className="loans-section highest-risk-section"><div className="section-heading"><div><h2>Highest-risk supported loan{highestRisk&&<span className="count">1 of {data.loans.length}</span>}</h2><p>Selected by current LTV divided by the protocol liquidation threshold—not a weighted score.</p></div><span className="jupiter-label"><span/>Jupiter Lend · read only</span></div>{highestRisk?<BorrowPositions data={data} context={context} onStress={onStress} compactLoanId={highestRisk.loan.id}/>:<BorrowPositions data={data} context={context} onStress={onStress} compactLoanId="none"/>}</section>
    <div className="provenance-strip"><div><span className="source-stamp"><Check size={15}/></span><div><strong>Dated holdings. Visible coverage.</strong><p>SPY · {data.etfs[0]?.holdingsDate?date(data.etfs[0].holdingsDate):'Unavailable'} · {data.etfs[0]?.constituents.length || 0} issuer rows</p></div></div><div><span className="amber-dot"/>QQQ undecomposed<span className="divider"/>Sector coverage is partial</div></div>
  </>;
}
