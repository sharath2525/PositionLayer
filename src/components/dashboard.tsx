'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Activity, ArrowRight, ArrowUpRight, BriefcaseBusiness, ChartNoAxesCombined, ChevronRight, CircleHelp, Clock3, ExternalLink, Eye, Fingerprint, FlaskConical, Layers3, LayoutDashboard, LockKeyhole, RefreshCw, Search, Shield, Wallet, AlertCircle, Database, CircleCheck, Link2, Moon, Sun } from 'lucide-react';
import { brand } from '@/config/brand';
import { verifiedVaults } from '@/config/instruments';
import { exposure, type CompanyExposure, type SectorExposure } from '@/domain/exposure';
import { isSnapshotStale, LIVE_FOREGROUND_REFRESH_MS } from '@/domain/freshness';
import type { Portfolio, PortfolioResult, PositionSelection } from '@/domain/types';
import { sampleProvider } from '@/services/sample';
import { browserLiveProvider } from '@/services/browser-live';
import { useWallet } from './use-wallet';
import { barWidth, date, percent, short, time, usd } from './format';
import { Modal } from './modal';
import { Protect } from './protect';
import { MarketContext } from './market-context';
import type { ReadContext } from '@/domain/guards';
import { AssetIcon } from './portfolio/portfolio-sections';
import { OverviewView } from './views/overview-view';
import { PortfolioView } from './views/portfolio-view';
import { StocksView } from './views/stocks-view';
import { CanonicalStocksView } from './views/canonical-stocks-view';

type View = 'overview' | 'stocks' | 'portfolio' | 'exposure' | 'protect';
const WORKSPACE_KEY = 'positionlayer:workspace:v1';
const THEME_KEY = 'positionlayer:theme:v1';
export function Dashboard() {
  const wallet = useWallet();
  const [view, setView] = useState<View>('overview');
  const [canonicalPreview, setCanonicalPreview] = useState(process.env.NEXT_PUBLIC_MARKET_V2_UI_PREVIEW === 'true');
  const canonicalPreviewAvailable = process.env.NODE_ENV !== 'production'
    || process.env.NEXT_PUBLIC_MARKET_V2_UI_PREVIEW === 'true';
  const [mode, setMode] = useState<'sample' | 'live'>('live');
  const [watched, setWatched] = useState<string | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    const next = saved === 'dark' || saved === 'light' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    void Promise.resolve().then(() => setTheme(next));
  }, []);
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next; localStorage.setItem(THEME_KEY, next); setTheme(next);
  }
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<PositionSelection | undefined>();
  const [focusedLoanId, setFocusedLoanId] = useState<string | null>(null);
  const [focusedMarketMint, setFocusedMarketMint] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; value: PortfolioResult } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => { void Promise.resolve().then(() => setNow(Date.now())); const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const requestId = useRef(0);
  const lastAutomaticRefreshAt = useRef(0);
  const owner = wallet.account?.address || watched;
  useEffect(() => { lastAutomaticRefreshAt.current = 0; }, [mode, owner, selection?.vaultId, selection?.positionId]);
  useEffect(() => {
    if (wallet.account && watched === wallet.account.address) void Promise.resolve().then(() => setWatched(null));
  }, [wallet.account, watched]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null') as { mode?: unknown; owner?: unknown } | null;
        if (saved?.mode === 'live') { setMode('live'); if (typeof saved.owner === 'string') setWatched(saved.owner); }
      } catch { localStorage.removeItem(WORKSPACE_KEY); }
      setWorkspaceReady(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!workspaceReady) return;
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ mode, owner: mode === 'live' ? owner || wallet.rememberedAddress : null }));
  }, [workspaceReady, mode, owner, wallet.rememberedAddress]);
  const key = `${mode}:${owner || ''}:${selection?.vaultId || ''}:${selection?.positionId || ''}:${refresh}`;
  useEffect(() => {
    const request = ++requestId.current;
    const controller = new AbortController();
    if (!workspaceReady) return () => controller.abort();
    if (mode === 'live' && !owner) return () => controller.abort();
    const provider = mode === 'sample' ? sampleProvider : browserLiveProvider;
    void provider.read(owner, controller.signal, selection).then(value => {
      if (!controller.signal.aborted && request === requestId.current) setResult({ key, value });
    }).catch(error => {
      if (!controller.signal.aborted && request === requestId.current) setResult({ key, value: { status: 'error', code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : 'Request failed.' } });
    });
    return () => { controller.abort(); };
  }, [key, mode, owner, selection, workspaceReady]);
  const current = result?.key === key ? result.value : null;
  const data = current && current.status !== 'error' ? current.data : null;
  const disconnected = workspaceReady && mode === 'live' && !owner;
  const loading = !workspaceReady || (!disconnected && current === null);
  const liveObservedAt = data?.mode === 'live' ? data.observedAt : null;
  const riskViewVisible = view === 'overview' || view === 'portfolio' || view === 'protect';
  useEffect(() => {
    if (!workspaceReady || mode !== 'live' || !owner || !liveObservedAt || !riskViewVisible) return;
    const observedAt = Date.parse(liveObservedAt);
    if (!Number.isFinite(observedAt)) return;
    let requested = false;
    let timer: number | null = null;
    const trigger = () => {
      if (requested || document.visibilityState !== 'visible') return;
      requested = true;
      lastAutomaticRefreshAt.current = Date.now();
      setRefresh(value => value + 1);
    };
    const dueAt = Math.max(observedAt + LIVE_FOREGROUND_REFRESH_MS, lastAutomaticRefreshAt.current + LIVE_FOREGROUND_REFRESH_MS);
    const remaining = dueAt - Date.now();
    if (remaining <= 0) trigger();
    else timer = window.setTimeout(trigger, remaining);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && Date.now() >= dueAt) trigger();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [liveObservedAt, mode, owner, riskViewVisible, workspaceReady]);
  const context: ReadContext = { owner: mode==='sample'?null:owner, cluster:'solana:mainnet', now };
  const viewCopy = {
    overview: { title: 'Overview', eyebrow: 'YOUR PORTFOLIO, IN PERSPECTIVE', heading: 'Know what you hold.', description: 'Your essential portfolio, exposure, and loan-risk answers.' },
    stocks: canonicalPreview ? { title: 'Stocks', eyebrow: 'CANONICAL CATALOG PREVIEW · NO WALLET REQUIRED', heading: 'Tokenized Stock Prices on Solana', description: 'Exact issuer identities, independently reported prices, and explicit data coverage.' }
      : { title: 'Stocks', eyebrow: '300 ISSUER-CONFIRMED ASSETS · NO WALLET REQUIRED', heading: 'Tokenized Stock Prices on Solana', description: 'A broad issuer-confirmed market with shared keyless price updates every 30 seconds.' },
    portfolio: { title: 'Portfolio', eyebrow: 'EVERY POSITION · ONE RECONCILED VIEW', heading: 'Your whole portfolio.', description: 'Wallet, Earn, borrow, indexed, and excluded records—clearly separated.' },
    exposure: { title: 'Exposure', eyebrow: 'UNDERLY · LOOK THROUGH YOUR HOLDINGS', heading: 'Different tokens. Shared exposure.', description: 'See the companies you own directly and through your ETFs.' },
    protect: { title: 'Protect', eyebrow: 'POSITIONLAYER · READ-ONLY PROTECTION PLANNING', heading: 'Plan for a different market.', description: 'Explore a scenario, choose a target, and understand the cash it would take.' },
  }[view];
  function changeMode(next: 'sample' | 'live') { setMode(next); setSelection(undefined); }
  function disconnect() { setWatched(null); setSelection(undefined); void wallet.disconnect(); }
  return <div className="app-shell">
    <a href="#main" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <Link href="/" className="brand"><span className="brand-mark"><Image src="/brand/positionlayer-layer-mark.png" alt="" width={38} height={38}/></span>{brand.name}<span className="brand-dot">.</span></Link>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => setView('overview')}><LayoutDashboard size={18}/>Overview</button>
        <button aria-label="Stocks" className={view === 'stocks' ? 'nav-item active' : 'nav-item'} onClick={() => { setFocusedMarketMint(null); setView('stocks'); }}><ChartNoAxesCombined size={18}/>Stocks</button>
        <button className="nav-item unavailable" type="button" disabled aria-disabled="true" title="Market analysis is coming soon"><Activity size={18}/>Market analysis<span className="nav-tag">Soon</span></button>
        <button aria-label="Portfolio" className={view === 'portfolio' ? 'nav-item active' : 'nav-item'} onClick={() => setView('portfolio')}><BriefcaseBusiness size={18}/>Portfolio</button>
        <button aria-label="Exposure" className={view === 'exposure' ? 'nav-item active' : 'nav-item'} onClick={() => setView('exposure')}><Layers3 size={18}/>Exposure<span className="nav-tag">Underly</span></button>
        <button aria-label="Protect" className={view==='protect'?'nav-item active':'nav-item'} onClick={()=>setView('protect')}><Shield size={18}/>Protect<span className="nav-tag">Plan</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="read-only-card"><Eye size={19}/><strong>A clearer view.<br/>You stay in control.</strong><p>Explore your portfolio and review hypothetical plans.</p><span><LockKeyhole size={11}/>Read only · no signing</span></div>
        <button className="source-nav" onClick={() => setSourcesOpen(true)}><Database size={16}/>Data & methodology<ArrowUpRight size={14}/></button>
        <div className="network"><span className="status-dot"/>Solana mainnet <span>Read only</span></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={13}/><strong>{viewCopy.title}</strong></div><div className="topbar-actions">
        <span className="read-only-label"><Shield size={14}/>Wallet controlled</span>
        <button className="icon-button theme-toggle" aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} onClick={toggleTheme}>{theme === 'light' ? <Moon size={18}/> : <Sun size={18}/>}</button>
        <button className="icon-button" aria-label="Data and methodology" onClick={() => setSourcesOpen(true)}><CircleHelp size={18}/></button>
        {owner && mode === 'live' ? <button className="connect-button" onClick={disconnect}><Wallet size={15}/>{short(owner)}<span>Disconnect</span></button> : <button className="connect-button" onClick={() => setConnectOpen(true)}><Wallet size={16}/>Connect wallet</button>}
      </div></header>
      <main id="main">
        {view !== 'stocks' && <div className={`mode-banner ${mode}`}><div>{mode === 'sample' ? <FlaskConical size={17}/> : <Link2 size={17}/>}<strong>{mode === 'sample' ? 'Sample portfolio · simulated values' : `Live portfolio · ${wallet.account ? 'connected wallet' : watched ? 'public address · read only' : 'not connected'}`}</strong><span>{mode === 'sample' ? 'Explore how your holdings fit together.' : owner ? `${short(owner)} · Solana mainnet` : 'Connect to read your onchain holdings.'}</span></div><div className="mode-choices" role="group" aria-label="Data mode"><button className="mode-choice sample" type="button" aria-pressed={mode === 'sample'} onClick={() => changeMode('sample')}>Sample</button><button className="mode-choice live" type="button" aria-pressed={mode === 'live'} onClick={() => changeMode('live')}>Live</button></div></div>}
        <div className="page-heading"><div className="eyebrow">{viewCopy.eyebrow}</div><div className="heading-row"><div><h1>{viewCopy.heading}</h1><p>{viewCopy.description}</p></div>{view !== 'stocks' && <button className="button secondary refresh" onClick={() => setRefresh(r => r+1)} disabled={loading || disconnected}><RefreshCw size={14} className={loading ? 'spin' : ''}/>{loading ? 'Reading…' : 'Refresh data'}</button>}</div></div>
        {view === 'stocks' ? <>
          {canonicalPreviewAvailable && <div className="canonical-preview-switch" role="group" aria-label="Stock catalog view">
            <button type="button" aria-pressed={!canonicalPreview} onClick={() => setCanonicalPreview(false)}>Current market</button>
            <button type="button" aria-pressed={canonicalPreview} onClick={() => setCanonicalPreview(true)}>Canonical preview</button>
            <span>Preview is opt-in; the approved market remains the rollback view.</span>
          </div>}
          {canonicalPreview ? <CanonicalStocksView portfolio={data} initialMint={focusedMarketMint}
            onPortfolio={() => setView('portfolio')} onExposure={() => setView('exposure')} onProtect={() => setView('protect')}/>
            : <StocksView portfolio={data} initialMint={focusedMarketMint}
              onPortfolio={() => setView('portfolio')} onExposure={() => setView('exposure')} onProtect={() => setView('protect')}/>}
        </> : <>
        {wallet.error && <div role="alert" className="notice error"><AlertCircle size={17}/>{wallet.error}</div>}
        {disconnected && <ConnectionEmpty onConnect={() => setConnectOpen(true)} onWatch={address => { setWatched(address); setSelection(undefined); }}/ >}
        {loading && <Loading/>}
        {current?.status === 'error' && <div className="panel state-card error-state" role="alert"><span className="state-icon"><AlertCircle size={30}/></span><h2>Live data couldn’t be loaded</h2><p>{current.message}</p><p className="muted">No sample data has been substituted. You can retry or switch to Sample explicitly.</p><button className="button" onClick={() => setRefresh(r=>r+1)}>Retry live read<RefreshCw size={15}/></button></div>}
        {data && <>{data.holdings.length === 0 && data.loans.length === 0 && !(data.walletAssets?.length || data.earnPositions?.length || data.unmodeledLoans?.length || data.indexedPositions?.length) ? <div className="panel state-card"><span className="state-icon"><Wallet size={29}/></span><h2>{data.loanRead === 'ready' ? 'No balances or positions found' : 'No account data to display yet'}</h2><p>No non-zero wallet balances or Jupiter positions were returned for this address.</p><p className="muted">{data.loanRead === 'ready' ? 'Refresh after a confirmed account change.' : 'Loan discovery is incomplete. Check the coverage notes or read a specific position.'}</p></div> : view==='protect'?<Protect key={`${key}:${focusedLoanId||''}`} data={data} context={context} initialLoanId={focusedLoanId}/>:view==='portfolio'?<PortfolioView key={key} data={data} context={context} onStress={loanId=>{setFocusedLoanId(loanId);setView('protect');}} onMarket={mint=>{setFocusedMarketMint(mint);setView('stocks');}}/>:view === 'overview' ? <OverviewView data={data} context={context} onPortfolio={() => setView('portfolio')} onExposure={() => setView('exposure')} onStress={loanId=>{setFocusedLoanId(loanId);setView('protect');}}/> : <Exposure key={key} data={data}/>}
          <DataStatus data={data} now={now} stale={current?.status === 'stale' || isSnapshotStale(data,now)} selection={selection} onSelect={setSelection} onSources={() => setSourcesOpen(true)}/>
        </>}
        </>}
        <footer><span><Shield size={13}/>{brand.name} · {brand.tagline}</span><span>Wallet data stays on demand. Public market prices use a shared read-only cache.</span></footer>
      </main>
    </div>
    {connectOpen && <Modal title="Connect your wallet" onClose={() => setConnectOpen(false)}><p className="modal-description">Authorize access to your public Solana address only. PositionLayer uses it for read-only account analysis.</p>{wallet.wallets.length === 0 ? <div className="wallet-empty"><Wallet size={30}/><h3>No compatible wallet detected</h3><p>Open this app in a browser with a Solana Wallet Standard wallet installed, such as Phantom or Solflare.</p><p>You can also use Live → Read a public address.</p></div> : <div className="wallet-list">{wallet.wallets.map(w => <button key={w.name} disabled={wallet.connecting} onClick={async () => { await wallet.connect(w); setMode('live'); setWatched(null); setSelection(undefined); setConnectOpen(false); }}><Wallet size={19}/>{w.name}<ArrowRight size={17}/></button>)}</div>}<div className="modal-foot"><LockKeyhole size={14}/>PositionLayer does not request message signing, transaction signing, or transaction submission.</div></Modal>}
    {sourcesOpen && <Modal title="Data & methodology" onClose={() => setSourcesOpen(false)}><SourceDetails data={data}/></Modal>}
  </div>;
}

function ConnectionEmpty({ onConnect, onWatch }: { onConnect: () => void; onWatch: (address: string) => void }) {
  const [address,setAddress] = useState('');
  return <section className="panel state-card"><span className="state-icon"><Wallet size={32}/></span><div className="eyebrow">YOUR WALLET. YOUR PERSPECTIVE.</div><h2>Bring your portfolio into view</h2><p>Read token balances, Jupiter Earn deposits, borrow positions, and covered stock exposure.<br/>Your wallet stays in control.</p><button className="button" onClick={onConnect}><Wallet size={16}/>Connect wallet</button><details className="watch-form"><summary>Read a public address</summary><form onSubmit={event => { event.preventDefault(); onWatch(address.trim()); }}><label htmlFor="watch-address">Solana wallet address</label><div><input id="watch-address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="Enter a public wallet address" required minLength={32} maxLength={44}/><button className="button secondary" type="submit">Read</button></div></form></details></section>;
}
function Loading() { return <section className="loading" aria-busy="true" aria-label="Loading portfolio"><div role="status"><RefreshCw size={17} className="spin"/>Reading onchain balances and Jupiter positions…<span>Live sources are checked independently.</span></div><div className="metrics-grid">{[1,2,3,4].map(i=><div className="panel skeleton-metric" key={i}><span/><strong/><span/></div>)}</div><div className="panel skeleton-table">{[1,2,3,4].map(i=><div key={i}/>)}</div></section>; }
function PositionPicker({ onSelect, selected }: { onSelect: (value: PositionSelection | undefined) => void; selected?: PositionSelection }) {
  const [vaultId,setVault] = useState('80'); const [positionId,setPosition] = useState('');
  return <details className="position-picker"><summary><Search size={14}/>{selected ? `Selected Jupiter position ${selected.vaultId}/${selected.positionId}` : 'Can’t find your loan? Read a specific position'}</summary><form onSubmit={e=>{e.preventDefault();onSelect({vaultId:Number(vaultId),positionId:Number(positionId)});}}><label>Vault<select value={vaultId} onChange={e=>setVault(e.target.value)}>{verifiedVaults.map(v=><option key={v.vaultId} value={v.vaultId}>{v.instrumentId} / USDC · {v.vaultId}</option>)}</select></label><label>Position NFT ID<input type="number" min="1" max="4294967295" step="1" value={positionId} onChange={e=>setPosition(e.target.value)} required/></label><button className="button secondary">Read position</button>{selected && <button type="button" className="text-button" onClick={()=>onSelect(undefined)}>Discover all</button>}</form><p>Ownership is checked onchain. A selected-position snapshot excludes other loans.</p></details>;
}
function DataStatus({ data, now, stale, selection, onSelect, onSources }: { data: Portfolio; now: number; stale: boolean; selection?: PositionSelection; onSelect: (value: PositionSelection | undefined) => void; onSources: () => void }) {
  return <section className="page-data-status" aria-label="Data status and coverage">
    <div className="section-heading status-heading"><div><h2>Data status &amp; coverage</h2><p>Observation time, market context, source coverage, and manual loan discovery.</p></div></div>
    <div className="data-line"><span><Clock3 size={13}/>{data.mode === 'sample' ? 'Fixture snapshot' : 'Account observation'} · {date(data.observedAt)} · {time(data.observedAt)}</span><button onClick={onSources}>View sources<ArrowUpRight size={13}/></button></div>
    <MarketContext data={data} now={now}/>
    {stale && <div className="notice"><Clock3 size={18}/>This snapshot is stale. Refresh before relying on the quantities or valuation.</div>}
    {data.mode === 'live' && <PositionPicker onSelect={onSelect} selected={selection}/>}
    {data.issues.length > 0 && <details className="coverage-notice"><summary><AlertCircle size={15}/>Coverage details<span>{data.issues.length} notes</span></summary><ul>{data.issues.map((issue,i) => <li key={i}>{issue}</li>)}</ul></details>}
  </section>;
}
function Exposure({ data }: { data: Portfolio }) {
  const result = exposure(data); const [query,setQuery] = useState(''); const [tab,setTab] = useState<'companies'|'sectors'>('companies'); const [expanded,setExpanded] = useState(false); const [selected,setSelected] = useState<CompanyExposure|null>(null); const [selectedSector,setSelectedSector] = useState<SectorExposure|null>(null);
  const filtered = result.companies.filter(c => `${c.name} ${c.ticker}`.toLowerCase().includes(query.toLowerCase()));
  const rows = expanded || query ? filtered : filtered.slice(0,10);
  return <>
    <div className="exposure-intro"><div><span className="eyebrow">COVERED STOCK SLEEVE</span><strong>{usd(result.valuedStockUsd==='0'?null:result.valuedStockUsd)}</strong><p>Reference value · wallet + Earn + posted</p></div><div><span className="eyebrow">COMPANY LOOK-THROUGH</span><strong>{percent(result.companyCoverage)}</strong><p>{result.companies.length} mapped companies</p></div><div className="unknown-summary"><span className="eyebrow">UNDECOMPOSED / RESIDUAL</span><strong>{usd(result.valuedStockUsd==='0'?null:result.unknownCompanyUsd)}</strong><p>QQQ, fund cash, and unmapped coverage</p></div></div>
    {result.unvaluedStockHoldings>0&&<div className="notice"><AlertCircle size={17}/>{result.unvaluedStockHoldings} stock balance(s) have no verified reference price. They are excluded from dollar totals and percentages.</div>}
    <div className="exposure-grid"><section className="panel exposure-table-panel"><div className="panel-heading"><div className="tabs"><button aria-pressed={tab==='companies'} onClick={()=>setTab('companies')}>Companies</button><button aria-pressed={tab==='sectors'} onClick={()=>setTab('sectors')}>Sectors</button></div>{tab==='companies'&&<label className="search-field"><Search size={15}/><input aria-label="Search companies" placeholder="Find a company" value={query} onChange={e=>setQuery(e.target.value)}/></label>}</div>
      {tab==='companies'?<><div className="table-scroll"><table className="exposure-table"><thead><tr><th>Company</th><th className="numeric">Direct</th><th className="numeric">Through ETFs</th><th className="numeric">Total exposure</th><th>Sleeve weight</th></tr></thead><tbody>{rows.map((c,i)=><tr key={c.id}><td><button className="company-button" onClick={()=>setSelected(c)}><span className="rank">{i+1}</span><AssetIcon id={c.ticker} label={c.name} kind="company"/><span><strong>{c.name}</strong><small>{c.ticker} · {c.sector||'Sector unclassified'}</small></span></button></td><td className="numeric">{usd(c.directUsd)}</td><td className="numeric">{usd(c.etfUsd)}</td><td className="numeric"><strong>{usd(c.amountUsd)}</strong></td><td className="weight-cell"><strong>{percent(c.sleeveWeight)}</strong><div className="weight-track"><span style={{width:barWidth(c.sleeveWeight)}}/></div></td></tr>)}</tbody></table></div>{!rows.length&&<div className="no-results">{query?'No matching companies.':'Company exposure needs verified reference prices.'}</div>}{filtered.length>10&&!query&&<button className="show-all" onClick={()=>setExpanded(!expanded)}>{expanded?'Show top 10':`Show all ${filtered.length} companies`}<ChevronRight size={14}/></button>}</>:
        <><div className="table-scroll"><table className="exposure-table sector-table"><thead><tr><th>Sector</th><th className="numeric">Direct stocks</th><th className="numeric">Through ETFs</th><th className="numeric">Total exposure</th><th>Sleeve weight</th></tr></thead><tbody>{result.sectors.map((s,i)=><tr key={s.name}><td><button className="company-button sector-button" onClick={()=>setSelectedSector(s)}><span className="rank">{i+1}</span><span><strong>{s.name}</strong><small>{s.sourceIds.length} verified source{s.sourceIds.length===1?'':'s'}</small></span></button></td><td className="numeric">{usd(s.directUsd)}</td><td className="numeric">{usd(s.etfUsd)}</td><td className="numeric"><strong>{usd(s.amountUsd)}</strong></td><td className="weight-cell"><strong>{percent(s.sleeveWeight)}</strong><div className={`weight-track ${s.name.startsWith('Unknown')?'unknown':''}`}><span style={{width:barWidth(s.sleeveWeight)}}/></div></td></tr>)}</tbody></table></div><div className="panel-bottom"><CircleCheck size={14}/>SPY sectors use State Street’s dated fund allocation; direct xStocks use PositionLayer’s named-company taxonomy. QQQ remains unknown.</div></>}
      <div className="panel-bottom"><CircleHelp size={14}/>{result.denominator}.</div></section>
      <aside className="exposure-aside"><div className="panel insight-panel"><Layers3 size={23}/><h3>One company.<br/>More than one route.</h3><p>Direct shares and ETF holdings add up to your total company exposure.</p><div className="route-example"><span>Direct stock</span><span>+ ETF contribution</span><strong>= Company exposure</strong></div><p className="muted">Select a company to inspect every contribution and its source.</p></div><div className="panel coverage-panel"><h3>What’s inside the funds</h3>{data.etfs.map(f=><div className="fund-source" key={f.id}><AssetIcon id={f.fundId} label={`${f.fundId} ETF`} kind="fund"/><div><strong>{f.fundId}</strong><span>{f.holdingsDate?`${date(f.holdingsDate)} · ${f.constituents.length} rows`:'Holdings unavailable'}</span><small>{f.status==='unavailable'?'100% undecomposed':`${percent(f.coverageWeight,4)} company coverage`}</small></div></div>)}<p>Unknown coverage stays in the denominator. Missing prices are counted separately.</p></div></aside></div>
    {selected&&<Modal title={`${selected.name} exposure`} onClose={()=>setSelected(null)}><div className="selected-company"><AssetIcon id={selected.ticker} label={selected.name} kind="company"/><span>{selected.ticker}</span></div><p className="exposure-total">{usd(selected.amountUsd)}<span>{percent(selected.sleeveWeight)} of covered stock sleeve</span></p>{selected.contributions.map((c,i)=><div className="contribution" key={i}><AssetIcon id={c.instrumentId}/><div><strong>{c.instrumentId} · {c.scope==='wallet'?'wallet':c.scope==='earn'?'Earn':'posted collateral'}</strong><span>{c.etfSnapshotId?'ETF look-through':c.scope==='earn'?'Earn underlying':'Direct holding'}</span><small>{c.etfSnapshotId || c.sourceId}</small></div><strong>{usd(c.amountUsd)}</strong></div>)}<p className="modal-foot">Reference USD exposure. This is not a sale quote or a liquidation valuation.</p></Modal>}
    {selectedSector&&<Modal title={`${selectedSector.name} sector`} onClose={()=>setSelectedSector(null)}><p className="exposure-total">{usd(selectedSector.amountUsd)}<span>{percent(selectedSector.sleeveWeight)} of covered stock sleeve</span></p><div className="sector-breakdown"><div><span>Direct stocks</span><strong>{usd(selectedSector.directUsd)}</strong></div><div><span>Through ETFs</span><strong>{usd(selectedSector.etfUsd)}</strong></div></div><h3>Sources</h3>{selectedSector.sourceIds.length?selectedSector.sourceIds.map(id=><code className="sector-source" key={id}>{id}</code>):<p className="muted">Residual or unclassified exposure has no deeper sector assignment.</p>}<p className="modal-foot">Dated reference USD exposure. Fund-level sector weights and company look-through are separate sourced views.</p></Modal>}
  </>;
}
function SourceDetails({ data }: { data: Portfolio | null }) { return <div className="source-details"><div className="method-item"><Fingerprint size={20}/><div><h3>Asset identity</h3><p>Core collateral is matched by mint, token program, and decimals. Additional tokenized securities require an exact Solana-mint match against their issuer record; Jupiter supplies token verification and prices. Wallet, Earn, and posted balances remain separate.</p></div></div><div className="method-item"><ChartNoAxesCombined size={20}/><div><h3>Separate valuation bases</h3><p>Exposure uses dated Jupiter reference USD observations. Loan LTV uses the protocol liquidation oracle in USDC. Hypothetical stress changes only the planning model.</p></div></div><div className="method-item"><Clock3 size={20}/><div><h3>Read-only data and privacy</h3><p>Onchain integer amounts are checked against each mint’s program and decimals. The configured Solana RPC and Jupiter receive the public address and account data needed for their reads. PositionLayer requests no signature and sends no transaction.</p></div></div>{data?.etfs.map(f=><div className="source-fund" key={f.id}><h3>{f.fundId} · {f.holdingsDate?date(f.holdingsDate):'Unavailable'}</h3><p>{f.note}</p><dl><dt>Reported weight</dt><dd>{percent(f.reportedWeight,6)}</dd><dt>Residual</dt><dd>{percent(f.residualWeight,6)}</dd>{f.sectorAllocation&&<><dt>Sector allocation</dt><dd>{date(f.sectorAllocation.asOf)} · {percent(f.sectorAllocation.coverageWeight,2)} covered</dd></>}<dt>Retrieved</dt><dd>{date(f.source.retrievedAt)} · {time(f.source.retrievedAt)}</dd></dl>{f.source.url&&<a href={f.source.url} target="_blank" rel="noreferrer">Issuer source<ExternalLink size={13}/></a>}{f.sectorAllocation?.source.url&&<a href={f.sectorAllocation.source.url} target="_blank" rel="noreferrer">Official sector breakdown<ExternalLink size={13}/></a>}</div>)}<div className="notice"><CircleCheck size={18}/>Current features, source limits, and methodology are documented in docs/PRODUCT_GUIDE.md and docs/METHODOLOGY.md.</div></div>; }
