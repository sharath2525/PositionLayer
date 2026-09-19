'use client';

import { ArrowDownLeft, ChartNoAxesCombined, CircleCheck, Database, Fingerprint, Landmark, Shield } from 'lucide-react';
import { byId } from '@/config/instruments';
import { exposure } from '@/domain/exposure';
import { stockPositionRows } from '@/domain/portfolio';
import { summary } from '@/domain/valuation';
import type { Portfolio } from '@/domain/types';
import type { ReadContext } from '@/domain/guards';
import { amount, usd, usdAmount } from '@/components/format';
import { BorrowPositions, EarnPositions, ExcludedAssets, HoldingsTable, IndexedPositions, StockPositionsTable } from '@/components/portfolio/portfolio-sections';

function Section({ id, title, count, description, icon, children }: { id: string; title: string; count: number; description: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section id={id} className="portfolio-section"><div className="section-heading"><div><h2>{icon}{title}<span className="count">{count}</span></h2><p>{description}</p></div></div>{children}</section>;
}

export function PortfolioView({ data, context, onStress, onMarket }: { data: Portfolio; context: ReadContext; onStress: (loanId:string)=>void; onMarket?: (mint:string)=>void }) {
  const totals = summary(data);
  const stockExposure = exposure(data);
  const stockRows = stockPositionRows(data, false);
  const cashHoldings = data.holdings.filter(holding => ['cash','crypto'].includes(byId[holding.instrumentId]?.kind || ''));
  const cashAssets = (data.walletAssets || []).filter(asset => asset.verification === 'verified' && !['stock','etf'].includes(asset.assetClass || ''));
  const earn = data.earnPositions || [];
  const borrowCount = data.loans.length + (data.unmodeledLoans?.length || 0);
  const excludedCount = (data.walletAssets || []).filter(asset => asset.verification !== 'verified').length + data.unsupported.length;
  return <>
    <div className="portfolio-reconciliation" aria-label="Portfolio reconciliation"><div><ChartNoAxesCombined size={17}/><span>Covered assets<strong>{usdAmount(totals.assetsReference)}</strong><small>Wallet + posted + Earn, once</small></span></div><div><Landmark size={17}/><span>Covered stock sleeve<strong>{usd(stockExposure.valuedStockUsd === '0' ? null : stockExposure.valuedStockUsd)}</strong><small>Reconciles with Exposure</small></span></div><div><ArrowDownLeft size={17}/><span>Outstanding debt<strong>{amount(totals.debtUsdc)} USDC</strong><small>Not subtracted inside asset groups</small></span></div><div><Shield size={17}/><span>{totals.complete?'Net equity':'Partial net equity'}<strong>{usdAmount(totals.equityReference)}</strong><small>Reference assets − protocol debt</small></span></div></div>
    <div className="portfolio-reconcile-note"><CircleCheck size={16}/>Asset totals include wallet, posted collateral, and Earn underlying value exactly once. Receipt tokens and indexed-only records are excluded.</div>
    <Section id="portfolio-stocks" title="Stocks and ETFs" count={stockRows.length} description="Complete verified wallet and posted-collateral inventory. Earn holdings are grouped separately below." icon={<Landmark size={17}/>}><div className="panel"><StockPositionsTable rows={stockRows} onMarket={onMarket}/><div className="panel-bottom"><Fingerprint size={14}/>Identity is based on exact Solana mint records, never a ticker match. Select a row to open its public market detail.</div></div></Section>
    <Section id="portfolio-cash" title="Cash and crypto" count={cashHoldings.length + cashAssets.length} description="Free wallet cash, crypto, and other verified wallet balances." icon={<ChartNoAxesCombined size={17}/>}><div className="panel"><HoldingsTable holdings={cashHoldings} walletAssets={cashAssets}/></div></Section>
    <EarnPositions positions={earn}/>
    <Section id="portfolio-borrow" title="Borrow positions" count={borrowCount} description="Complete modeled and unmodeled loan inventory. Posted collateral is represented once in Stocks and ETFs." icon={<Shield size={17}/>}><BorrowPositions data={data} context={context} onStress={onStress}/></Section>
    <Section id="portfolio-indexed" title="Other indexed protocol positions" count={(data.indexedPositions || []).length} description="Comparison-only protocol records; never added to PositionLayer totals." icon={<Database size={17}/>}><IndexedPositions data={data}/></Section>
    <Section id="portfolio-excluded" title="Unverified and excluded assets" count={excludedCount} description="Suspicious, unverified, receipt, and unsupported records remain visible but outside totals." icon={<Fingerprint size={17}/>}><ExcludedAssets data={data}/></Section>
  </>;
}
