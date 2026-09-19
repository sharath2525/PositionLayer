'use client';
import { Clock3, Globe2, Database, CalendarClock, AlertCircle } from 'lucide-react';
import { marketSession } from '@/domain/market';
import { multiplierEvent, sourceState, HOLDINGS_MAX_AGE_MS } from '@/domain/guards';
import type { Portfolio, Source } from '@/domain/types';
import { byId } from '@/config/instruments';
import { date, number, time } from './format';

function age(source: Source, now: number) { const seconds = Math.max(0,Math.floor((now-Date.parse(source.observedAt))/1000));return seconds<60?`${seconds}s`:seconds<3600?`${Math.floor(seconds/60)}m`:`${Math.floor(seconds/3600)}h`; }
export function MarketContext({data,now}:{data:Portfolio;now:number}) {
  if (!now) return null;
  const session=marketSession(now);
  const states=[...new Map(data.holdings.map(h=>[h.mintState.mint,h.mintState])).values()];
  const events=states.filter(m=>multiplierEvent(m,now).status!=='current');
  return <details className="market-context">
    <summary><span><Globe2 size={15}/>{session.label}</span><span><Clock3 size={14}/>{data.mode==='sample'?'Account values simulated':`${data.loans.length} protocol position read(s)`}</span><span><Database size={14}/>{data.prices.filter(p=>p.basis==='reference').length?`${data.prices.length} reference observations`:'Reference prices unavailable'}</span><span className="context-more">Market & freshness</span></summary>
    <div className="context-body"><div><h3>Reference venue context</h3><p>{session.scope}.</p><p>{session.earlyClose?'Early close at 13:00 New York time. ':'Core session 09:30–16:00 New York time. '}{session.nextChangeAt?`Next scheduled ${session.status==='open'?'close':'open'}: ${date(session.nextChangeAt)} · ${time(session.nextChangeAt)}.`:'Next boundary unavailable.'}</p><p className="muted">Calendar {session.calendarId} · checked {session.checkedAt}. Market hours do not establish oracle freshness or token liquidity.</p></div>
      <div><h3>Independent source clocks</h3><ul>{data.loans.map(l=><li key={l.id}>{l.collateralInstrumentId} position {l.positionId}: protocol read {sourceState(l.source,data.mode,now)} · {data.mode==='sample'?'fixture':`${age(l.source,now)} old`}. Oracle publication time {data.mode==='sample'?'simulated':'unavailable'}.</li>)}{data.prices.map(p=><li key={`${p.instrumentId}:${p.source.id}`}>{p.instrumentId} reference: {sourceState(p.source,data.mode,now)} · {date(p.source.observedAt)} · {time(p.source.observedAt)}</li>)}{data.etfs.map(e=><li key={e.id}>{e.fundId}: {e.holdingsDate?`${e.holdingsDate} holdings · ${sourceState(e.source,data.mode,now,HOLDINGS_MAX_AGE_MS)}`:'full holdings unavailable'}.</li>)}</ul><p className="muted">Planning policy: account/price reads ≤2 minutes; company holdings ≤7 days; reviews expire after 60 seconds.</p></div></div>
    <div className="event-context"><h3><CalendarClock size={17}/>Token multiplier state</h3>{events.length===0?<p>No pending multiplier was reported in these mint observations.</p>:null}{states.filter(m=>m.tokenProgram!==byId.USDC.tokenProgram).map(m=>{const e=multiplierEvent(m,now);const instrument=Object.values(byId).find(i=>i.mint===m.mint);return <div key={m.mint} className={`event-row ${e.status==='refresh-required'?'event-attention':''}`}><strong>{instrument?.symbol}</strong><span>Observed ×{number(e.multiplier,8)}</span>{e.pendingMultiplier&&<span>Scheduled ×{number(e.pendingMultiplier,8)} · {new Date(e.effectiveAt!*1000).toISOString()}</span>}<p>{e.note}</p></div>;})}<p className="muted"><AlertCircle size={13}/>Reference values require matched event-state quantities and prices. Protection estimates use a separate protocol-USDC basis.</p></div>
  </details>;
}
