'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowRight, Clock3, ExternalLink,
  Layers3, Search, Copy, Star, Download } from 'lucide-react';
import type { Portfolio } from '@/domain/types';
import { localStockContext } from '@/domain/stock-intelligence';
import { CanonicalMarketQuerySchema, type CanonicalMarketQuery } from '@/domain/market-api-v2';
import { readBrowserCanonicalDetail, readBrowserCanonicalPage, cachedCanonicalPage } from '@/services/browser-market-v2';
import { flowPercent } from '@/domain/stock-rich-data';
import { decimal } from '@/domain/amounts';
import { date, time, usdAmount } from '@/components/format';
import { Modal } from '@/components/modal';
import { useWorkspaceStockTicker } from '@/components/workspace-stock-ticker';
import { useMarketColumns } from '@/components/use-market-columns';
import { StockLogo } from '@/components/stock-logo';
import { MarketColumnsMenu } from '@/components/market-columns-menu';
import { recordSessionPrices, type SessionHistory, type SessionPoint } from '@/domain/stock-session-trend';
import { referenceFreshness, type MarketField } from '@/domain/market-enrichment';
import { ageCanonicalPage, ageCanonicalDetail } from '@/domain/market-client-freshness';

type Page = Awaited<ReturnType<typeof readBrowserCanonicalPage>>;
type Row = Page['records'][number];
type Detail = Awaited<ReturnType<typeof readBrowserCanonicalDetail>>;

// Each pricing view opens with its own market-cap ranking.
const listedColumns = ['Company', 'Price', '24h %', 'Last 5d', 'MC', '24h Vol', 'Token', 'Underlying', 'Market', 'Exchange'] as const;
type ListedColumn = typeof listedColumns[number];
const tokenColumns = ['Asset', 'Type', 'Underlying', 'Age', 'Price', '24h %', 'Trend', 'Official', 'xStocks Q.', 'Toked MC', 'FDV', 'Circ Supply', 'Total Supply', 'Shares', 'Mult', 'Solana Mint', 'Market', 'Exchange', 'Liq $', 'Vol 24h', 'Flow', 'Holders'] as const;
type TokenColumn = typeof tokenColumns[number];
const defaultTokenColumns: readonly TokenColumn[] = ['Asset', 'Price', '24h %', 'Trend', 'Toked MC', 'Liq $', 'Vol 24h', 'Market'];

const initialQuery: CanonicalMarketQuery = CanonicalMarketQuerySchema.parse({
  pageSize: 20, sort: 'reportedCap', direction: 'desc',
});

const CanonicalLogo = StockLogo;

function identityLabel(row: Row) {
  if (row.verification !== 'issuer-confirmed') return 'Indexed or unresolved · not issuer-confirmed';
  if (row.productClass === 'equity') return `${row.listingCountry ?? ''} equity · issuer-confirmed mint`;
  if (row.productClass === 'etf') return `${row.listingCountry ?? ''} ETF · issuer-confirmed mint`;
  return 'Issuer-confirmed mint · security class unverified';
}

function companyCapLabel(cap: Row['companyCap']) {
  return cap.status === 'estimated' ? usdAmount(cap.valueUsd)
    : cap.status === 'not-applicable' ? 'N/A · ETF' : 'Unavailable';
}

function dateTime(value: string | null) {
  return value ? `${date(value)} · ${time(value)}` : 'Unavailable';
}

function compactCap(value: string | null) {
  return value === null ? '—' : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2,
  }).format(Number(value));
}

function fieldValue(field: MarketField | null | undefined) {
  return !field ? '—' : new Intl.NumberFormat('en-US',{...(field.currency?{style:'currency',currency:field.currency}:{}),maximumFractionDigits:field.value>=1?2:6}).format(field.value);
}
function ReferenceValue({ field, label = 'Underlying reference' }: { field: MarketField | null | undefined; label?: string }) {
  const value=label==='Company cap'&&field ? new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2,...(field.currency?{style:'currency',currency:field.currency}:{})}).format(field.value):fieldValue(field);
  return <span className="market-price-value" title={field ? `${label} · Jupiter stockData · ${referenceFreshness(field)} · ${field.currency??'currency unverified'} · retrieved ${dateTime(field.retrievedAt)}${field.observedAt?` · observed ${dateTime(field.observedAt)}`:''}`:`${label} unavailable`}><strong>{value}</strong></span>;
}
function ChangeValue({ field }: { field: MarketField | null | undefined }) {
  return <span className={field?(field.value<0?'ticker-negative':'ticker-positive'):undefined}>{field ? `${field.value >= 0 ? '+' : ''}${field.value.toFixed(2)}%` : '—'}</span>;
}

export function CanonicalStocksView({ portfolio = null, initialMint = null, onPortfolio, onExposure, onProtect }: {
  portfolio?: Portfolio | null; initialMint?: string | null;
  onPortfolio?: () => void; onExposure?: () => void; onProtect?: () => void;
}) {
  const listedPrefs = useMarketColumns('positionlayer:listed-columns:v1', listedColumns, listedColumns);
  const tokenPrefs = useMarketColumns('positionlayer:token-columns:v1', tokenColumns, defaultTokenColumns);
  const visibleColumns = listedPrefs.columns;
  const [history, setHistory] = useState<SessionHistory>(new Map());
  const [draftSearch, setDraftSearch] = useState(initialMint ?? '');
  const [query, setQuery] = useState<CanonicalMarketQuery>({ ...initialQuery, search: initialMint ?? '' });
  const [page, setPage] = useState<Page | null>(()=>cachedCanonicalPage({...initialQuery,search:initialMint??''}));
  const [watchlist,setWatchlist]=useState<string[]>([]);
  const [watchOnly,setWatchOnly]=useState(false);
  const [compact,setCompact]=useState(false);
  const [exporting,setExporting]=useState(false);
  const [exportMessage,setExportMessage]=useState('');
  const [readVersion, setReadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ticker = useWorkspaceStockTicker();
  const publishTicker = ticker?.publish;
  const tickerSelection = ticker?.selection;
  useEffect(() => { if (page) publishTicker?.(page); }, [page, publishTicker]);
  useEffect(() => {
    if (tickerSelection) void Promise.resolve().then(() => setSelectedId(tickerSelection.id));
  }, [tickerSelection]);
  const initialOpened = useRef(false);
  const searchInput=useRef<HTMLInputElement>(null);
  const local = useMemo(() => localStockContext(portfolio), [portfolio]);
  useEffect(()=>{const handler=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;
    if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!target.closest('input,textarea,select,[contenteditable=true]')){event.preventDefault();searchInput.current?.focus();}};
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);
  useEffect(()=>{void Promise.resolve().then(()=>{try{const saved=JSON.parse(localStorage.getItem('positionlayer:stock-watchlist:v1')??'[]');
    if(Array.isArray(saved))setWatchlist(saved.filter((m):m is string=>typeof m==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)).slice(0,100));
    setCompact(localStorage.getItem('positionlayer:stock-density:v1')==='compact');}catch{}});},[]);
  function toggleWatch(mint:string){const next=watchlist.includes(mint)?watchlist.filter(m=>m!==mint):[...watchlist,mint].slice(-100);setWatchlist(next);
    try{localStorage.setItem('positionlayer:stock-watchlist:v1',JSON.stringify(next));}catch{}
    if(watchOnly)update('watchlist',next.join(',')||'none');}
  function toggleDensity(){setCompact(!compact);try{localStorage.setItem('positionlayer:stock-density:v1',compact?'comfortable':'compact');}catch{}}
  async function exportRows(){if(!page)return;setExporting(true);setExportMessage('Preparing filtered export…');
    try{const response=await fetch('/api/markets/v2/stocks-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,columns:query.view==='listed'?visibleColumns:tokenPrefs.columns}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error('Export temporarily unavailable. Please retry.');
      const blob=await response.blob();
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`positionlayer-${query.view}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      setExportMessage(`Exported ${response.headers.get('X-Export-Rows')??'all'} filtered rows.`);
    }catch(e){setExportMessage(e instanceof Error?e.message:'Export unavailable.');}finally{setExporting(false);}}

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if(query.search===draftSearch.trim())return;
      const next={...query,search:draftSearch.trim(),page:1};
      setPage(cachedCanonicalPage(next));setQuery(next);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftSearch,query]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) { setLoading(true); setError(null); const cached=cachedCanonicalPage(query);if(cached)setPage(cached); } });
    void readBrowserCanonicalPage(query, controller.signal)
      .then(result => { if (!controller.signal.aborted) { const fresh = ageCanonicalPage(result); setHistory(previous => { const next = new Map(previous); recordSessionPrices(next, fresh); return next; }); setPage(fresh); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Catalog unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, readVersion]);
  useEffect(() => {
    if (!initialMint || initialOpened.current || !page) return;
    const match = page.records.find(row => row.variantMints.includes(initialMint));
    if (match) { initialOpened.current = true; void Promise.resolve().then(() => setSelectedId(match.id)); }
  }, [initialMint, page]);
  useEffect(() => {
    const aging = window.setInterval(() => setPage(current => current ? ageCanonicalPage(current) : current), 5_000);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReadVersion(value => value + 1);
    }, 30_000);
    return () => { window.clearInterval(timer); window.clearInterval(aging); };
  }, []);
  function update<K extends keyof CanonicalMarketQuery>(key: K, value: CanonicalMarketQuery[K]) {
    const next={ ...query, ...(key === 'view' ? { sort: value === 'listed' ? 'listedCap' as const : 'reportedCap' as const, direction: 'desc' as const } : {}), [key]: value, page: key === 'page' ? Number(value) : 1 };
    setPage(cachedCanonicalPage(next));setQuery(next);
  }

  return <section className={`stocks-market canonical-market${compact?' stocks-compact':''}`} aria-label="Solana stock market">
      <div className="market-mode-toolbar">
        <div className="canonical-preview-switch" role="group" aria-label="Stock pricing view">
          <button type="button" aria-pressed={query.view === 'tokenized'} onClick={() => update('view', 'tokenized')}>Tokenized</button>
          <button type="button" aria-pressed={query.view === 'listed'} onClick={() => update('view', 'listed')}>Listed</button>
        </div>
        <span className="sr-only" role="status">{loading && page ? 'Refreshing the cached snapshot.' : ''}</span>
      </div>

    {page && <div className="market-summary canonical-summary" aria-label="Canonical market coverage summary" title={`Coverage at completed snapshot: ${dateTime(page.prices.completedAt)}`}>
      {query.view === 'tokenized' ? <>
      <div><span>Tokenized market cap</span><strong title={usdAmount(page.summary.reportedTokenizedCapUsd)}>{compactCap(page.summary.reportedTokenizedCapUsd)}</strong><small>{page.summary.reportedCapMintCount}/{page.summary.exactMintCount} mints · provider-reported{page.summary.reportedCapMintCount < page.summary.exactMintCount ? ' · partial' : ''}</small></div>
      <div><span>Onchain-price available</span><strong>{page.summary.displayPriceLiveMintCount + page.summary.displayPriceDelayedMintCount + page.summary.displayPriceStaleMintCount}/{page.summary.exactMintCount}</strong><small>{page.summary.displayPriceLiveMintCount} live · {page.summary.displayPriceDelayedMintCount} delayed · {page.summary.displayPriceStaleMintCount} stale</small></div>
      <div><span>Total searchable identities / Unique Solana mints</span><strong>{page.summary.canonicalCount}/{page.summary.exactMintCount}</strong><small>{page.summary.issuerConfirmedMintCount} issuer-confirmed mints</small></div>
      <div><span>Liquid mints</span><strong>{page.summary.liquidMintCount}</strong><small>Positive reported onchain liquidity</small></div>
      </> : <>
        <div><span>Listed references available</span><strong>{page.summary.referencePriceCount}/{page.summary.canonicalCount}</strong><small>Independent underlying references</small></div>
        <div><span>Company cap coverage</span><strong>{page.summary.providerCompanyCapCount}/{page.summary.canonicalCount}</strong><small>Provider-reported · ETFs excluded</small></div>
        <div><span>Total searchable identities / Unique Solana mints</span><strong>{page.summary.canonicalCount}/{page.summary.exactMintCount}</strong><small>Same catalog as Tokenized</small></div>
        <div><span>Last snapshot update</span><strong>{page.prices.completedAt ? time(page.prices.completedAt) : '—'}</strong><small>{page.prices.completedAt ? date(page.prices.completedAt) : 'Awaiting price snapshot'}</small></div>
      </>}
    </div>}
    <section className="panel market-panel" data-snapshot-id={page?.prices.snapshotId}>
      <div className="market-controls">
      <div className="market-toolbar">
        <label className="market-search"><Search size={15}/><span className="sr-only">Search canonical catalog</span>
          <input ref={searchInput} value={draftSearch} maxLength={64} autoComplete="off"
            onChange={event => setDraftSearch(event.target.value.slice(0, 64))}
            placeholder="Search name, ticker, ISIN, or exact mint"/></label>
        <label><span>Type</span><select aria-label="Canonical asset type" value={query.type}
          onChange={event => update('type', event.target.value as CanonicalMarketQuery['type'])}>
          <option value="all">All classes</option><option value="equity">Equity</option><option value="etf">ETF</option><option value="other">Unclassified / other</option>
        </select></label>
        <label><span>Identity</span><select aria-label="Canonical verification" value={query.verification}
          onChange={event => update('verification', event.target.value as CanonicalMarketQuery['verification'])}>
          <option value="all">All identities</option><option value="issuer-confirmed">Issuer-confirmed</option><option value="other">Indexed / unresolved</option>
        </select></label>
        <label><span>Price</span><select aria-label="Canonical price availability" value={query.price}
          onChange={event => update('price', event.target.value as CanonicalMarketQuery['price'])}>
          <option value="all">All prices</option><option value="observed">{query.view === 'listed' ? 'Reference shown' : 'Token price shown'}</option><option value="available">{query.view === 'listed' ? 'Reference available' : 'Calculation-eligible'}</option><option value="unavailable">{query.view === 'listed' ? 'No reference' : 'No token price'}</option>
        </select></label>
        <label><span>Sort</span><select aria-label="Sort canonical market" value={query.sort}
          onChange={event => update('sort', event.target.value as CanonicalMarketQuery['sort'])}>
          <option value="availability">Prices first</option><option value="name">Name</option><option value="price">{query.view === 'listed' ? 'Reference price (by currency)' : 'Token price'}</option><option value="variants">Variants</option>{query.view === 'listed' ? <option value="listedCap">Company cap (by currency)</option> : <option value="reportedCap">Token market cap</option>}
          <option value="change">Change</option><option value="volume">Volume</option>{query.view==='tokenized'&&<><option value="liquidity">Liquidity</option><option value="holders">Holders</option><option value="fdv">FDV</option></>}
        </select></label>
        <button className="sort-direction" type="button" aria-label={`Sort ${query.direction === 'asc' ? 'descending' : 'ascending'}`}
          onClick={() => update('direction', query.direction === 'asc' ? 'desc' : 'asc')}>
          <ArrowDown size={16} className={query.direction === 'asc' ? 'ascending' : ''}/>
        </button>
      </div>
      {exportMessage&&<p className="market-cap-note" role="status">{exportMessage}</p>}
      <div className="market-extra-controls">
        <label><span className="sr-only">Market status</span><select aria-label="Market status" value={query.market} onChange={event => update('market', event.target.value as CanonicalMarketQuery['market'])}>
          <option value="all">All markets</option><option value="open">Open now</option><option value="closed">Closed</option><option value="halted">Halted</option><option value="unknown">Status unknown</option>
        </select></label>
        <label><span className="sr-only">Listing country</span><select aria-label="Listing country" value={query.country} onChange={event => update('country', event.target.value)}>
          <option value="all">All countries</option>{(page?.facets.countries ?? []).map(country => <option key={country}>{country}</option>)}
        </select></label>
        <label><span className="sr-only">Listing currency</span><select aria-label="Listing currency" value={query.currency} onChange={event => update('currency', event.target.value)}>
          <option value="all">All currencies</option>{(page?.facets.currencies ?? []).map(currency => <option key={currency}>{currency}</option>)}
        </select></label>
        <button type="button" className="stock-tool-button" aria-pressed={watchOnly} onClick={()=>{setWatchOnly(!watchOnly);update('watchlist',!watchOnly?(watchlist.join(',')||'none'):'');}}><Star size={13}/>Watchlist</button>
        <label><span className="sr-only">Rows per page</span><select aria-label="Rows per page" value={query.pageSize} onChange={e=>update('pageSize',Number(e.target.value))}><option value={20}>20 rows</option><option value={50}>50 rows</option></select></label>
        <button type="button" className="stock-tool-button" aria-pressed={compact} onClick={toggleDensity}>{compact?'Comfortable':'Compact'}</button>
        <button type="button" className="stock-tool-button" disabled={!page||exporting} onClick={()=>void exportRows()} title="Export all filtered rows, selected columns and source timestamps"><Download size={13}/>{exporting?'Exporting…':'CSV'}</button>
        <MarketColumnsMenu view={query.view}>
          {query.view === 'tokenized' ? tokenColumns.map(column => <label key={column}><input type="checkbox" checked={tokenPrefs.columns.includes(column)}
            disabled={tokenPrefs.columns.length === 1 && tokenPrefs.columns.includes(column)} onChange={event => tokenPrefs.toggle(column, event.target.checked)}/>{column}</label>)
            : listedColumns.map(column => <label key={column}><input type="checkbox" checked={visibleColumns.includes(column)}
              disabled={visibleColumns.length === 1 && visibleColumns.includes(column)} onChange={event => listedPrefs.toggle(column, event.target.checked)}/>{column}</label>)}
          <button type="button" className="text-button" onClick={query.view === 'tokenized' ? tokenPrefs.reset : listedPrefs.reset}>Reset columns</button>
        </MarketColumnsMenu>
      </div>
      </div>
      {page?.source === 'bundled' && <div className="market-notice" role="status"><AlertCircle size={16}/><span>
        <strong>{page.prices.cycleState === 'idle' && page.summary.priceAttemptedMintCount === 0
          ? 'Price writer is not connected or has not started.' : 'Dated reviewed catalog fallback.'}</strong>
        <small>{page.prices.cycleState === 'idle' && page.summary.priceAttemptedMintCount === 0
          ? 'No Jupiter price batch has run for this preview. A single persistent market host must run the shared writer; page reloads only read its snapshot.'
          : 'Live issuer and price coverage is not proven here. Unknown-class mints are searchable, not counted as verified U.S. stocks or ETFs.'}</small>
      </span></div>}
      {error && page && <div className="market-notice stale" role="status"><AlertCircle size={16}/><span>
        <strong>Latest snapshot read failed.</strong><small>The previously loaded page remains visible; no sample data was substituted.</small>
      </span></div>}
      {error && !page && <div className="market-empty" role="alert"><AlertCircle size={27}/><h2>Catalog temporarily unavailable</h2><p>{error}</p><button className="button" onClick={() => setReadVersion(value => value + 1)}>Retry snapshot read</button></div>}
      {loading && !page && <div className="market-empty" aria-busy="true"><Clock3 size={25}/><h2>Reading the canonical catalog…</h2><p>No wallet or upstream price request is needed for this read.</p></div>}

      {page && <>
        {query.view === 'listed' ? <ListedTable rows={page.records} columns={visibleColumns} onSelect={setSelectedId} watchlist={watchlist} onWatch={toggleWatch}/>
          : <TokenizedTable rows={page.records} columns={tokenPrefs.columns} history={history} onSelect={setSelectedId} held={local.held} watchlist={watchlist} onWatch={toggleWatch}/>}
        <div className="market-cards">{page.records.map(row => <article key={row.id} className="market-card">
          <button className="stock-watch" aria-label={`${watchlist.includes(row.displayPrice.mint)?'Remove':'Add'} ${row.name} ${watchlist.includes(row.displayPrice.mint)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(row.displayPrice.mint)} onClick={()=>toggleWatch(row.displayPrice.mint)}><Star size={16}/></button>
          <button className="market-card-head" onClick={() => setSelectedId(row.id)} aria-label={`View ${row.name} variants`}>
            <CanonicalLogo url={row.logoUrl} symbol={row.symbol}/><span><strong>{row.name}</strong><small>{row.symbol} · {identityLabel(row)}</small></span><ArrowRight size={15}/>
          </button>
          {(query.view === 'listed' ? visibleColumns.includes('Price') : tokenPrefs.columns.includes('Price')) && <div className="market-card-price">
            {query.view === 'listed' ? <ListedValue row={row} column="Price"/> : <TokenValue row={row} column="Price" points={history.get(row.displayPrice.mint)}/>}
          </div>}
          <div className="market-card-grid listed-card-fields">{query.view === 'listed'
            ? listedColumns.filter(column => visibleColumns.includes(column) && column !== 'Company' && column !== 'Price').map(column =>
              <span key={column}>{column}<strong><ListedValue row={row} column={column}/></strong></span>)
            : tokenColumns.filter(column => tokenPrefs.columns.includes(column) && column !== 'Asset' && column !== 'Price').map(column =>
              <span key={column}>{column}<strong><TokenValue row={row} column={column} points={history.get(row.displayPrice.mint)}/></strong></span>)}
          </div>
          {row.variantMints.some(mint => local.held.has(mint)) && <em className="held-badge">In this portfolio</em>}
        </article>)}</div>
        {!page.records.length && <div className="market-empty"><Search size={26}/><h2>{page.summary.canonicalCount ? 'No identities match these filters' : 'No catalog identities are available'}</h2>
          <p>{page.summary.canonicalCount ? `${page.summary.canonicalCount} identities remain in the catalog. Clear filters to see unpriced and unclassified entries.`
            : 'The issuer catalog is unavailable. No sample identities have been substituted.'}</p>
          {page.summary.canonicalCount > 0 && <button className="button secondary" type="button" onClick={() => { setDraftSearch(''); setQuery({ ...initialQuery, view: query.view, sort: query.view === 'listed' ? 'listedCap' : 'reportedCap' }); }}>Clear filters</button>}</div>}
        <div className="market-pagination"><span>{page.pagination.total ? `${(page.pagination.page - 1) * page.pagination.pageSize + 1}–${Math.min(page.pagination.page * page.pagination.pageSize, page.pagination.total)} of ${page.pagination.total}` : '0 records'}</span>
          <div><button className="button secondary" disabled={page.pagination.page <= 1 || loading} onClick={() => update('page', page.pagination.page - 1)}><ArrowLeft size={14}/>Previous</button>
            <span>Page {page.pagination.page}{page.pagination.totalPages ? ` of ${page.pagination.totalPages}` : ''}</span>
            <button className="button secondary" disabled={page.pagination.page >= page.pagination.totalPages || loading} onClick={() => update('page', page.pagination.page + 1)}>Next<ArrowRight size={14}/></button></div></div>
        <div className="panel-bottom"><Clock3 size={14}/>Snapshot {page.source} · cycle {page.prices.cycleState} · {page.prices.processedBatches}/{page.prices.totalBatches} batches · last completed {dateTime(page.prices.completedAt)}. Filtering and paging never call providers.</div>
      </>}
    </section>
    {page && <>
      <details className="canonical-coverage-details"><summary>Full catalog and provider coverage</summary><dl>
        <div><dt>Price provider</dt><dd>{page.providers.jupiterPrice} · {page.prices.failedBatchCount} failed batches</dd></div>
        <div><dt>Enrichment version</dt><dd>{page.enrichmentVersion??'Waiting for first enrichment'}</dd></div>
        <div><dt>Candidate mint records at catalog build</dt><dd>{page.summary.inputCandidateRecordCount}</dd></div>
        <div><dt>Unique candidate mints</dt><dd>{page.summary.inputUniqueMintCount}</dd></div>
        <div><dt>Duplicate candidate records</dt><dd>{page.summary.inputDuplicateRecordCount}</dd></div>
        <div><dt>Dated reviewed candidates</dt><dd>{page.summary.reviewedCandidateRecordCount}</dd></div>
        <div><dt>xStocks issuer read</dt><dd>{page.providers.xstocks} · {page.providers.xstocksRecords} records · {dateTime(page.providers.xstocksLastSuccess)}</dd></div>
        <div><dt>Jupiter stocks tag read</dt><dd>{page.providers.jupiterTag} · {page.providers.jupiterTagRecords} records · {dateTime(page.providers.jupiterTagLastSuccess)}</dd></div>
        <div><dt>Issuer-confirmed identities / mints</dt><dd>{page.summary.issuerConfirmedUnderlyingCount} / {page.summary.issuerConfirmedMintCount}</dd></div>
        <div><dt>Verified U.S. equity / ETF underlyings</dt><dd>{page.summary.verifiedUnderlyingCount}</dd></div>
        <div><dt>Standalone / multi-variant identities</dt><dd>{page.summary.canonicalCount - page.summary.multiVariantUnderlyingCount} / {page.summary.multiVariantUnderlyingCount}</dd></div>
        <div><dt>Equity / ETF / unclassified / other mints</dt><dd>{page.summary.equityMintCount} / {page.summary.etfMintCount} / {page.summary.unclassifiedMintCount} / {page.summary.otherClassMintCount}</dd></div>
        <div><dt>Unresolved / pending-removal / quarantined / delisted mints</dt><dd>{page.summary.unresolvedMintCount} / {page.summary.pendingRemovalMintCount} / {page.summary.quarantinedMintCount} / {page.summary.delistedMintCount}</dd></div>
        <div><dt>Conflicted / halted mints</dt><dd>{page.summary.conflictedMintCount} / {page.summary.haltedMintCount}</dd></div>
        <div><dt>Price targets / attempted / returned</dt><dd>{page.summary.priceTargetMintCount} / {page.summary.priceAttemptedMintCount} / {page.summary.priceReturnedMintCount}</dd></div>
        <div><dt>Calculation-eligible prices / eligible verified mints</dt><dd>{page.summary.priceAvailableMintCount} / {page.summary.eligibleVerifiedMintCount}</dd></div>
        <div><dt>Live / delayed / stale / unavailable exact-mint prices</dt><dd>{page.summary.displayPriceLiveMintCount} / {page.summary.displayPriceDelayedMintCount} / {page.summary.displayPriceStaleMintCount} / {page.summary.displayPriceUnavailableMintCount}</dd></div>
        <div><dt>24h onchain token volume</dt><dd>{usdAmount(page.summary.reportedVolume24hUsd)} · {page.summary.reportedVolumeMintCount}/{page.summary.exactMintCount} mints</dd></div>
        <div><dt>Reported tokenized cap coverage</dt><dd>{page.summary.reportedCapMintCount}/{page.summary.exactMintCount} mints</dd></div>
        <div><dt>Company cap available / unavailable / N/A</dt><dd>{page.summary.companyCapAvailableUnderlyingCount} / {page.summary.companyCapUnavailableUnderlyingCount} / {page.summary.companyCapNotApplicableUnderlyingCount}</dd></div>
        <div><dt>Underlying reference coverage</dt><dd>{page.summary.referencePriceCount} / {page.summary.canonicalCount} identities</dd></div>
        <div><dt>Provider-reported company cap coverage</dt><dd>{page.summary.providerCompanyCapCount} / {page.summary.canonicalCount} identities</dd></div>
      </dl>
      <div className="canonical-cap-grid">
        <div><span>Covered Solana tokenized cap</span><strong>{usdAmount(page.summary.coveredSolanaTokenizedCap.valueUsd)}</strong>
          <small>{page.summary.coveredSolanaTokenizedCap.eligibleMintCount} of {page.summary.coveredSolanaTokenizedCap.verifiedMintCount} issuer-confirmed mints · {page.summary.coveredSolanaTokenizedCap.status}</small></div>
        <div><span>Separately reported tokenized cap</span><strong>{usdAmount(page.summary.reportedTokenizedCapUsd)}</strong>
          <small>{page.summary.reportedCapMintCount} of {page.summary.exactMintCount} mints · {page.summary.reportedCapSource??'No source'} · partial, not company cap</small></div>
      </div>
      <p className="market-cap-note">A reported token cap is not the underlying company&apos;s market cap. {page.summary.coveredSolanaTokenizedCap.status === 'unavailable'
        ? 'Verified Solana-circulating supply is not available, so the derived covered cap remains unavailable.'
        : 'The derived covered cap includes only exact mints with qualified Solana-circulating supply and same-unit market prices.'} Provider-reported company cap is separate display context, with currency shown only when supplied; ETFs are N/A. Coverage counts describe the completed snapshot.</p>
      </details>

    </>}
    {selectedId && <CanonicalDetail assetId={selectedId} local={local} onClose={() => setSelectedId(null)}
      onPortfolio={onPortfolio} onExposure={onExposure} onProtect={onProtect}/>}
  </section>;
}

function SessionTrend({ points, label='Session trend' }: { points?: SessionPoint[]; label?:string }) {
  if (!points || points.length < 2) return <span title={`${label} needs two distinct price observations`}>—</span>;
  const values = points.map(point => point.value), min = Math.min(...values), max = Math.max(...values);
  const path = values.map((value, index) => `${2 + index * 92 / (values.length - 1)},${max === min ? 16 : 29 - (value - min) / (max - min) * 26}`).join(' ');
  return <svg className={`stock-session-trend ${values.at(-1)! >= values[0] ? 'up' : 'down'}`} viewBox="0 0 96 32" role="img"
    aria-label={`${label}: ${points.length} observed prices`}><title>{label} · {dateTime(points[0].at)} to {dateTime(points.at(-1)!.at)}</title>
    <polyline points={path} fill="none" stroke="currentColor" strokeWidth="2"/></svg>;
}

function MintActions({ mint }: { mint: string }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(mint); setMessage('Copied'); }
    catch { setMessage('Copy unavailable'); }
  }
  return <span className="stock-mint-actions"><code title={mint}>{mint.slice(0, 4)}…{mint.slice(-4)}</code>
    <button type="button" title="Copy Solana mint" aria-label={`Copy mint ${mint}`} onClick={() => void copy()}><Copy size={13}/></button>
    <a href={`https://solscan.io/token/${encodeURIComponent(mint)}`} target="_blank" rel="noreferrer" aria-label={`View mint ${mint} on Solscan`}><ExternalLink size={13}/></a>
    <small role="status">{message}</small></span>;
}

function TokenValue({ row, column, points }: { row: Row; column: TokenColumn; points?: SessionPoint[] }) {
  const data = row.marketData, context = row.issuerContext;
  const rich=row.rich,dex=rich?.dex;
  const supply = (kind: 'circulating' | 'total') => {
    const extra=kind==='circulating'?rich?.reserve?.circulating:rich?.holders?.totalSupply;
    if(extra!=null)return <span title={kind==='circulating'?`Issuer-wide circulating supply · ${dateTime(rich?.reserve?.retrievedAt??null)}`:`Solana total minted supply, before scaled-UI multiplier · ${dateTime(rich?.holders?.retrievedAt??null)}`}>{Number(extra).toLocaleString('en-US',{maximumFractionDigits:4})}</span>;
    const reserve = context?.reserve?.status === 'available' ? context.reserve : null;
    const value = kind === 'circulating' ? reserve?.circulatingSupply ?? context?.supply?.circulating : context?.supply?.total;
    const field = kind === 'circulating' ? data?.circulatingPrescaled : data?.totalPrescaled;
    return value != null ? <span title={`Issuer-wide supply across deployments · retrieved ${dateTime(reserve?.retrievedAt ?? context?.supply?.retrievedAt ?? null)}`}>
      {Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 })}<small className="canonical-cell-note">Issuer-wide</small></span>
      : field ? <span title={`Jupiter prescaled supply; not verified Solana-circulating units · ${dateTime(field.retrievedAt)}`}>
        {field.value.toLocaleString('en-US', { maximumFractionDigits: 4 })}<small className="canonical-cell-note">Prescaled</small></span> : <span title="Supply not supplied">—</span>;
  };
  switch (column) {
    case 'Type': return <span title={identityLabel(row)}>{row.productClass === 'unknown' ? 'Unclassified' : row.productClass === 'etf' ? 'ETF' : row.productClass}</span>;
    case 'Underlying': return <ListedValue row={row} column="Underlying"/>;
    case 'Price': return <span className="market-price-value" title={row.displayPrice.priceUsd?`${row.displayPrice.source} · ${row.displayPrice.status} · ${dateTime(row.displayPrice.observedAt)}`:`No token quote · ${row.displayPrice.reason??'not observed'}`}><strong>{usdAmount(row.displayPrice.priceUsd)}</strong>{row.displayPrice.status==='STALE'&&<small>Last known price</small>}</span>;
    case '24h %': return <ChangeValue field={dex?.change24h!=null?{value:dex.change24h,currency:null,retrievedAt:dex.retrievedAt}:data?.change24h}/>;
    case 'Trend': return <SessionTrend points={points}/>;
    case 'Official': return <ReferenceValue field={row.listedData?.referencePrice}/>;
    case 'xStocks Q.': return rich?.quote ? <span title={`Issuer indicative quote · ${dateTime(rich.quote.retrievedAt)}`}>{usdAmount(String(rich.quote.priceUsd))}</span> : context?.issuerIndicativePriceUsd ? <span title={`Issuer indicative quote; ${dateTime(context.issuerPriceRetrievedAt)}`}>
      {usdAmount(context.issuerIndicativePriceUsd)}<small className="canonical-cell-note">{dateTime(context.issuerPriceRetrievedAt)}</small></span> : <span title="No cached issuer indicative quote">—</span>;
    case 'Toked MC': return <span title={`Provider-reported token capitalization · ${row.reportedCapMintCount}/${row.variantCount} mints · ${dateTime(row.reportedCapRetrievedAt)}`}>{compactCap(row.reportedTokenizedCapUsd)}</span>;
    case 'FDV': return <span title={dex?.fdv!=null?`DEX provider-reported FDV · ${dateTime(dex.retrievedAt)}; not a supply-derived valuation`:'FDV not supplied'}>{compactCap(dex?.fdv?.toString()??null)}</span>;
    case 'Circ Supply': return supply('circulating');
    case 'Total Supply': return supply('total');
    case 'Shares': return rich?.reserve?.shares!=null ? <span title={`Issuer backing shares · ${rich.reserve.custodians.join(', ')} · ${dateTime(rich.reserve.observedAt??rich.reserve.retrievedAt)}`}>{Number(rich.reserve.shares).toLocaleString('en-US',{maximumFractionDigits:4})}</span> : context?.reserve?.status === 'available' && context.reserve.sharesHeld !== null
      ? <span title={`Issuer-wide backing shares · ${dateTime(context.reserve.retrievedAt)} · ${context.reserve.holdings.map(item => item.provider).join(', ')}`}>
        {Number(context.reserve.sharesHeld).toLocaleString('en-US', { maximumFractionDigits: 4 })}<small className="canonical-cell-note">Issuer backing</small></span>
      : <span title="No cached issuer backing shares">—</span>;
    case 'Mult': return data?.multiplier ? <span title={`Jupiter multiplier · ${dateTime(data.multiplier.retrievedAt)}`}>{data.multiplier.value.toLocaleString('en-US', { maximumFractionDigits: 5 })}</span> : <>—</>;
    case 'Solana Mint': return <MintActions mint={row.displayPrice.mint}/>;
    case 'Market': return <ListedValue row={row} column="Market"/>;
    case 'Exchange': return <ListedValue row={row} column="Exchange"/>;
    case 'Liq $': return dex?.liquidity!=null ? <span title={`Highest-liquidity exact-mint DEX pool · ${dateTime(dex.retrievedAt)}`}>{compactCap(String(dex.liquidity))}</span> : data?.liquidity ? <span title={`Exact-mint liquidity · ${dateTime(data.liquidity.retrievedAt)}`}>{compactCap(String(data.liquidity.value))}</span> : <>—</>;
    case 'Vol 24h': return <span title={`Reported 24h token volume · ${row.reportedVolumeMintCount}/${row.variantCount} mints`}>{compactCap(row.reportedVolume24hUsd)}</span>;
    case 'Age': return data?.tokenCreatedAt?<TokenAge at={data.tokenCreatedAt}/>:<span title="Token creation date is not supplied. Pool creation date is shown in details when available.">—</span>;
    case 'Flow': {const flow=flowPercent(rich);return <span title={dex?`Buy transactions / all transactions over 24h · ${dex.buys??'—'} buys / ${dex.sells??'—'} sells · ${dateTime(dex.retrievedAt)}`:'No trading counts supplied'}>{flow!==null?`${flow.toFixed(0)}% buys`:'—'}{flow!==null&&<span className="stock-flow"><i style={{width:`${flow}%`}}/></span>}</span>;}
    case 'Holders': return <span title={rich?.holders?`RugCheck reported holder count · ${dateTime(rich.holders.retrievedAt)}`:'Holder count pending or unavailable'}>{rich?.holders?.count.toLocaleString('en-US')??'—'}</span>;
    default: return <>—</>;
  }
}

function TokenizedTable({ rows, columns, history, onSelect, held, watchlist, onWatch }: {
  rows: Row[]; columns: readonly TokenColumn[]; history: SessionHistory; onSelect: (id: string) => void; held: Set<string>;
  watchlist:string[];onWatch:(mint:string)=>void;
}) {
  return <div className="market-table-wrap tokenized-table-wrap" tabIndex={0} aria-label="Tokenized stocks; scroll horizontally for more columns">
    <table className="market-table canonical-table tokenized-table"><caption className="sr-only">Exact-mint token prices and independently sourced market context. — means unavailable.</caption>
      <thead><tr>{tokenColumns.filter(column => columns.includes(column)).map(column => <th key={column} className={column === 'Asset' ? 'stock-asset-column' : undefined}>{column}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} tabIndex={0} aria-label={`Details for ${row.name}`}
        onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') onSelect(row.id); }}
        onClick={event => { if (!(event.target as HTMLElement).closest('button,a')) onSelect(row.id); }}>
        {tokenColumns.filter(column => columns.includes(column)).map(column => <td key={column} className={column === 'Asset' ? 'stock-asset-column' : undefined}>
          {column === 'Asset' ? <div className="stock-asset-actions"><button className="stock-watch" aria-label={`${watchlist.includes(row.displayPrice.mint)?'Remove':'Add'} ${row.name} ${watchlist.includes(row.displayPrice.mint)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(row.displayPrice.mint)} onClick={()=>onWatch(row.displayPrice.mint)}><Star size={14}/></button><button className="market-asset" onClick={() => onSelect(row.id)} aria-label={`View ${row.name} variants`}>
            <CanonicalLogo url={row.logoUrl} symbol={row.symbol}/><span><strong>{row.tokenSymbol ?? row.symbol}</strong><small>{row.name}</small>
              <small title={identityLabel(row)}>{row.verification}{row.variantCount > 1 ? ` · ${row.variantCount} variants` : ''}</small>
              {row.variantMints.some(mint => held.has(mint)) && <em className="held-badge">In this portfolio</em>}
            </span></button></div> : <TokenValue row={row} column={column} points={history.get(row.displayPrice.mint)}/>}
        </td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function ListedValue({ row, column }: { row: Row; column: ListedColumn }) {
  const listed=row.rich?.listed;
  switch (column) {
    case 'Price': return listed?.price!=null?<strong title={`Yahoo Finance · ${listed.symbol} · ${dateTime(listed.observedAt)} · retrieved ${dateTime(listed.retrievedAt)}`}>{fieldValue({value:listed.price,currency:listed.currency,retrievedAt:listed.retrievedAt})}</strong>:<ReferenceValue field={row.listedData?.referencePrice}/>;
    case '24h %': return <span title="Change from previous trading-session close"><ChangeValue field={listed?.change!=null?{value:listed.change,currency:null,retrievedAt:listed.retrievedAt}:null}/></span>;
    case 'Last 5d': return <span title={listed?`Last five trading sessions · ${listed.currency} · ${dateTime(listed.retrievedAt)}`:'History not yet supplied'}><SessionTrend points={listed?.closes} label="Five-day history"/></span>;
    case '24h Vol': return <span title={listed?`Regular session share volume · ${dateTime(listed.observedAt)}`:'Share volume not supplied'}>{listed?.volume!=null?new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(listed.volume):'—'}</span>;
    case 'MC': return row.productClass === 'etf' ? <>N/A · ETF</> : <ReferenceValue field={row.listedData?.companyCap} label="Company cap"/>;
    case 'Token': return <>{row.tokenSymbol ?? '—'}{row.variantCount > 1 ? ' +' + (row.variantCount - 1) : ''}</>;
    case 'Underlying': return <>{row.symbol}<small className="canonical-cell-note">{[row.listingCountry, row.listingCurrency].filter(Boolean).join(' · ') || 'Listing unavailable'}</small></>;
    case 'Market': return <span className="listed-market-status" title={row.marketStatusValidUntil ? 'Listed exchange session valid until ' + dateTime(row.marketStatusValidUntil) : 'Exchange session has not been supplied'}>{row.marketStatus}</span>;
    case 'Exchange': return <>{row.listingExchange ?? '—'}</>;
    default: return <span title={'Listed ' + column + ' data unavailable'}>—</span>;
  }
}
function ListedTable({ rows, columns, onSelect, watchlist, onWatch }: { rows: Row[]; columns: readonly ListedColumn[]; onSelect: (id: string) => void; watchlist:string[];onWatch:(mint:string)=>void }) {
  return <div className="market-table-wrap"><table className="market-table canonical-table listed-table">
    <caption className="sr-only">Listed company prices, session change, five-day history and share volume. — means unavailable.</caption>
    <thead><tr>{listedColumns.filter(column => columns.includes(column)).map(column => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>{listedColumns.filter(column => columns.includes(column)).map(column => <td key={column}>
      {column === 'Company' ? <div className="stock-asset-actions"><button className="stock-watch" aria-label={`${watchlist.includes(row.displayPrice.mint)?'Remove':'Add'} ${row.name} ${watchlist.includes(row.displayPrice.mint)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(row.displayPrice.mint)} onClick={()=>onWatch(row.displayPrice.mint)}><Star size={14}/></button><button className="market-asset" onClick={() => onSelect(row.id)} aria-label={'View ' + row.name + ' variants'}>
        <CanonicalLogo url={row.logoUrl} symbol={row.symbol}/><span><strong>{row.symbol}</strong><small>{row.name}</small></span>
      </button></div> : column === 'Token' ? <button type="button" className="text-button" onClick={() => onSelect(row.id)} aria-label={'View ' + row.name + ' tokens'}><ListedValue row={row} column={column}/> →</button>
      : <ListedValue row={row} column={column}/>}
    </td>)}</tr>)}</tbody>
  </table></div>;
}

function CanonicalDetail({ assetId, local, onClose, onPortfolio, onExposure, onProtect }: {
  assetId: string; local: ReturnType<typeof localStockContext>; onClose: () => void;
  onPortfolio?: () => void; onExposure?: () => void; onProtect?: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setDetail(current => current ? ageCanonicalDetail(current) : current), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void readBrowserCanonicalDetail(assetId, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Detail unavailable.'); });
    const timer=window.setInterval(()=>{void readBrowserCanonicalDetail(assetId,controller.signal).then(value=>{if(!controller.signal.aborted){setDetail(value);setError(null);}}).catch(()=>{});},30_000);
    return () => {clearInterval(timer);controller.abort();};
  }, [assetId]);
  const held = detail?.variants.some(row => local.held.has(row.mint)) ?? false;
  const protectedLoan = detail?.variants.some(row => local.protectedMints.has(row.mint)) ?? false;
  const detailDisplay = detail?.variants.find(row => row.displayPrice.priceUsd !== null)?.displayPrice ?? null;
  return <Modal className="stock-drawer canonical-drawer" title="Canonical asset details" onClose={onClose}>
    {!detail && !error && <p className="drawer-loading" role="status">Loading exact-mint variants from the cached snapshot…</p>}
    {error && <p className="drawer-error" role="alert"><AlertCircle size={14}/>{error}</p>}
    {detail && <>
      <StockCalculator detail={detail}/>
      <section className="drawer-section"><div className="drawer-section-heading"><span>01</span><h3>Underlying identity</h3></div>
        <strong>{detail.variants[0]?.variant.underlying.symbol ?? detail.variants[0]?.variant.tokenSymbol ?? detail.asset.id}</strong>
        <p className="canonical-detail-note">{detail.asset.verification} · {detail.asset.productClass} · {detail.asset.variantMints.length} exact Solana variant{detail.asset.variantMints.length === 1 ? '' : 's'}</p>
        <dl className="stock-detail-list compact"><dt>Canonical ID</dt><dd><code>{detail.asset.id}</code></dd><dt>Underlying ISIN</dt><dd>{detail.asset.underlyingIsin ?? 'Unresolved'}</dd>
          <dt>Security class</dt><dd>{detail.asset.securityClass ?? 'Unavailable'}</dd><dt>Issuer evidence</dt><dd>{detail.asset.verification === 'issuer-confirmed' ? 'Exact mint declaration' : 'Not issuer-confirmed'}</dd></dl>
      </section>
      <section className="drawer-section"><div className="drawer-section-heading"><span>02</span><h3>Token-market observation</h3></div>
        <div className="drawer-price"><span>{detailDisplay?.source === 'dexscreener' ? 'DEX market' : 'Jupiter Price V3'} · exact Solana mint · USD</span>
          <strong>{usdAmount(detail.selectedPrice.selected?.priceUsd ?? detailDisplay?.priceUsd ?? null)}</strong>
          <small>{detail.selectedPrice.selected ? `${detail.selectedPrice.selected.mint} · ${dateTime(detail.selectedPrice.selected.providerObservedAt)}`
            : detailDisplay ? `${detailDisplay.mint} · ${detailDisplay.status} · display-only, not calculation-eligible · ${dateTime(detailDisplay.observedAt)}`
              : `Price unavailable · ${detail.selectedPrice.reason ?? 'no eligible observation'}`}</small></div>
        <p className="canonical-detail-note">Issuer/company references are independent display context, never substitutes for a token-market price. No competing observations are averaged.</p>
      </section>
      <section className="drawer-section"><div className="drawer-section-heading"><span>03</span><h3>Exact-mint variants</h3></div>
        <div className="canonical-variants">{detail.variants.map(row => {
          const proof = row.variant.evidence.find(item => item.kind === 'issuer-declaration');
          return <article key={row.mint} className="canonical-variant">
            <div className="canonical-variant-heading"><CanonicalLogo
              url={row.variant.issuer === 'xstocks' && row.variant.verification === 'issuer-confirmed'
                ? `https://xstocks-metadata.backed.fi/logos/tokens/${encodeURIComponent(row.variant.tokenSymbol)}.png` : null}
              symbol={row.variant.tokenSymbol}/><span><strong>{row.variant.tokenName ?? row.variant.tokenSymbol}</strong>
                <small>{row.variant.issuer} · {row.variant.verification} · {row.catalogState}</small></span></div>
            {row.rich&&<><dl className="stock-detail-list compact">
              <dt>DEX liquidity / volume</dt><dd>{compactCap(row.rich.dex?.liquidity?.toString()??null)} / {compactCap(row.rich.dex?.volume24h?.toString()??null)} · highest-liquidity exact-mint pool</dd>
              <dt>Reported token cap / FDV</dt><dd>{compactCap(row.rich.dex?.marketCap?.toString()??null)} / {compactCap(row.rich.dex?.fdv?.toString()??null)} · provider-reported</dd>
              <dt>24h buys / sells</dt><dd>{row.rich.dex?.buys??'—'} / {row.rich.dex?.sells??'—'}</dd>
              <dt>Pool created</dt><dd>{dateTime(row.rich.dex?.pairCreatedAt??null)} · pool age, not token age</dd>
              <dt>Holders</dt><dd>{row.rich.holders?.count.toLocaleString('en-US')??'—'} · {dateTime(row.rich.holders?.retrievedAt??null)}</dd>
              <dt>Backing shares / circulating</dt><dd>{row.rich.reserve?.shares??'—'} / {row.rich.reserve?.circulating??'—'} · issuer-wide</dd>
              <dt>Reserve timestamp</dt><dd>{dateTime(row.rich.reserve?.observedAt??null)} · {row.rich.reserve?.custodians.join(', ')||'—'}</dd>
              <dt>Issuer indicative quote</dt><dd>{usdAmount(row.rich.quote?.priceUsd?.toString()??null)} · {dateTime(row.rich.quote?.retrievedAt??null)}</dd>
              <dt>Listed close / currency</dt><dd>{row.rich.listed?.price??'—'} {row.rich.listed?.currency??''} · {dateTime(row.rich.listed?.observedAt??null)}</dd>
              <dt>Listed history</dt><dd><SessionTrend points={row.rich.listed?.closes} label="Five-day history"/></dd>
            </dl><div className="drawer-sources">{(['dex','reserve','quote','holders','listed'] as const).map(key=>row.rich?.[key]&&<a key={key} href={row.rich[key]!.sourceUrl} target="_blank" rel="noreferrer">{key} · {dateTime(row.rich[key]!.retrievedAt)}<ExternalLink size={12}/></a>)}</div></>}
            <dl className="stock-detail-list compact"><dt>Exact mint</dt><dd><code>{row.mint}</code></dd>
              <dt>Token program</dt><dd><code>{row.variant.tokenProgram ?? 'Unavailable'}</code></dd>
              <dt>Decimals</dt><dd>{row.variant.decimals ?? 'Unavailable'}</dd>
              <dt>Token price</dt><dd>{row.tokenPrice.status === 'eligible' ? `${usdAmount(row.tokenPrice.priceUsd)} · ${row.tokenPrice.unit.kind}:${row.tokenPrice.unit.id}` : `Unavailable · ${row.tokenPrice.reason}`}</dd>
              <dt>Display-only token price</dt><dd>{row.displayPrice.priceUsd !== null
                ? `${usdAmount(row.displayPrice.priceUsd)} · ${row.displayPrice.status} · ${dateTime(row.displayPrice.observedAt)}`
                : `Unavailable · ${row.displayPrice.reason}`}</dd>
              <dt>Last observed price</dt><dd>{row.lastObservation
                ? `${usdAmount(row.lastObservation.priceUsd)} · ${row.lastObservation.unit} · ${dateTime(row.lastObservation.observedAt)}${row.tokenPrice.status === 'blocked' ? ' · display context only' : ''}`
                : 'Unavailable'}</dd>
              <dt>Latest attempt</dt><dd>{row.lastAttempt ?? 'Not attempted'}{row.retainedLastGood ? ' · original last-known-good retained' : ''}</dd>
              <dt>Market status</dt><dd>{row.variant.tradingHalted === true ? 'Issuer halt' : row.variant.tradingHalted === false ? 'Not halted at source retrieval' : 'Unavailable'} · {row.variant.availability.issuerStatus}</dd>
              <dt>Liquidity</dt><dd>{row.variant.reportedLiquidityUsd !== null && row.variant.reportedLiquidityUsd !== undefined ? `${usdAmount(row.variant.reportedLiquidityUsd)} · Jupiter Tokens V2` : 'Unavailable'} · {row.variant.availability.liquidity}</dd>
              <dt>24h token volume</dt><dd>{row.variant.reportedVolume24hUsd != null ? `${usdAmount(row.variant.reportedVolume24hUsd)} · Jupiter Tokens V2` : 'Unavailable'}</dd>
              <dt>Jupiter Lend</dt><dd>{row.variant.availability.lend === 'unknown' ? 'Not verified in canonical snapshot' : row.variant.availability.lend}</dd>
              <dt>Issuer reference</dt><dd>{row.issuerReference.status === 'available' ? usdAmount(row.issuerReference.valueUsd) : `Unavailable · ${row.issuerReference.reason}`}</dd>
              <dt>Underlying reference</dt><dd><ReferenceValue field={row.marketData?.referencePrice}/></dd>
              <dt>Provider-reported company cap</dt><dd>{row.variant.productClass === 'etf' ? 'N/A · ETF' : <ReferenceValue field={row.marketData?.companyCap}/>}</dd>
              <dt>24h token change</dt><dd><ChangeValue field={row.marketData?.change24h}/>{row.marketData?.change24h && ` · ${dateTime(row.marketData.change24h.retrievedAt)}`}</dd>
              <dt>V3 token liquidity</dt><dd>{row.marketData?.liquidity ? `${usdAmount(String(row.marketData.liquidity.value))} · ${dateTime(row.marketData.liquidity.retrievedAt)}` : 'Unavailable'}</dd>
              <dt>Listing / session</dt><dd>{row.variant.underlying.listingCountry ?? 'Country unavailable'} · {row.variant.listing?.exchange ?? 'Exchange unavailable'} · {row.variant.listing?.currency ?? 'Currency unavailable'} · {row.variant.listing?.period ?? 'Session unavailable'} · {dateTime(row.variant.retrievedAt)}</dd>
              <dt>Next session change</dt><dd>{dateTime(row.variant.listing?.nextChangeAt ?? null)}</dd>
              <dt>Provider multiplier</dt><dd>{row.marketData?.multiplier ? `${row.marketData.multiplier.value} · ${dateTime(row.marketData.multiplier.retrievedAt)} · display metadata only` : 'Unavailable'}</dd>
              <dt>Provider next multiplier</dt><dd>{row.marketData?.pendingMultiplier ? `${row.marketData.pendingMultiplier.value} · effective ${dateTime(row.marketData.multiplierEffectiveAt ?? null)} · not applied to wallet amounts` : 'Unavailable'}</dd>
              <dt>Prescaled circulating / total supply</dt><dd>{row.marketData?.circulatingPrescaled?.value ?? 'Unavailable'} / {row.marketData?.totalPrescaled?.value ?? 'Unavailable'} · provider prescaled units; circulating scope unverified; excluded from cap calculations</dd>
              <dt>Derived Solana cap</dt><dd>{row.variantCap.status === 'eligible' ? `${usdAmount(row.variantCap.valueUsd)} · Solana circulating` : `Unavailable · ${row.variantCap.reason} (${row.variantCap.supplyScope} supply)`}</dd>
              <dt>Reported token cap</dt><dd>{row.variant.reportedTokenizedCapUsd !== null ? `${usdAmount(row.variant.reportedTokenizedCapUsd)} · Jupiter Tokens V2, scope not verified as Solana circulating` : 'Unavailable'}</dd>
              <dt>Company cap</dt><dd>{companyCapLabel(row.companyCap)}</dd>
              <dt>Identity retrieved</dt><dd>{dateTime(row.variant.retrievedAt)}</dd>
              <dt>Market metadata retrieved</dt><dd>{dateTime(row.variant.reportedMarketRetrievedAt ?? null)}</dd>
              <dt>Wallet context</dt><dd>{local.held.has(row.mint) ? 'Held in locally loaded portfolio' : 'No exact-mint holding loaded'}{local.protectedMints.has(row.mint) ? ' · supported loan collateral' : ''}</dd></dl>
            {(row.conflicts.length > 0 || row.variant.eligibility !== 'eligible') && <p className="canonical-warning"><AlertCircle size={13}/>{row.conflicts.length ? `Identity conflicts: ${row.conflicts.join(', ')}` : `Eligibility: ${row.variant.eligibility}. Not counted as a verified U.S. stock/ETF.`}</p>}
            <div className="drawer-sources">{proof && <a href={proof.sourceUrl} target="_blank" rel="noreferrer">Issuer exact-mint declaration<ExternalLink size={13}/></a>}
              {row.variant.evidence.filter(item => item !== proof).map(item => <a key={`${item.provider}:${item.sourceUrl}`} href={item.sourceUrl} target="_blank" rel="noreferrer">{item.provider} · {item.kind}<ExternalLink size={13}/></a>)}</div>
          </article>;
        })}</div>
      </section>
      <section className="drawer-section"><div className="drawer-section-heading"><span>04</span><h3>Data quality and next steps</h3></div>
        <p className="canonical-detail-note">Catalog source: {detail.source} · ID {detail.catalogId} · price snapshot {detail.priceSnapshotId ?? 'not yet published'}. Missing prices, liquidity, Lend markets, supply, and company caps are independent states—not zero values.</p>
        <dl className="stock-detail-list compact">
          <dt>Cached issuer indicative quote</dt><dd>{detail.context?.record.intelligence?.issuerIndicativePriceUsd
            ? `${usdAmount(detail.context.record.intelligence.issuerIndicativePriceUsd)} · ${dateTime(detail.context.record.intelligence.issuerPriceRetrievedAt)} · indicative only`
            : 'Unavailable · independent of the underlying reference'}</dd>
          <dt>Cached Lend availability</dt><dd>{detail.context?.record.intelligence?.lend.status === 'available'
            ? `${detail.context.record.intelligence.lend.vaults.length} vaults · ${dateTime(detail.context.record.intelligence.lend.observedAt)}`
            : 'Unavailable · not yet verified by the shared worker'}</dd>
          <dt>Cached Meteora evidence</dt><dd>{detail.context?.marketEvidence?.meteoraPool
            ? <a href={detail.context.marketEvidence.meteoraPool.sourceUrl} target="_blank" rel="noreferrer">{detail.context.marketEvidence.meteoraPool.source} · {dateTime(detail.context.marketEvidence.meteoraPool.retrievedAt)}<ExternalLink size={13}/></a>
            : 'Unavailable · not yet verified by the shared worker'}</dd>
        </dl>
        {detail.asset.conflicts.length > 0 && <p className="canonical-warning"><AlertCircle size={13}/>{detail.asset.conflicts.length} identity conflict(s) require review.</p>}
        {(onPortfolio || onExposure || onProtect) && <div className="drawer-navigation"><h3>Continue read-only analysis</h3><div>
          {onPortfolio && <button className="button secondary" onClick={onPortfolio}>View portfolio</button>}
          {held && onExposure && <button className="button secondary" onClick={onExposure}><Layers3 size={14}/>Explore exposure</button>}
          {protectedLoan && onProtect && <button className="button secondary" onClick={onProtect}>Open Protect</button>}
        </div></div>}
        <p className="modal-foot">No signing, trading, borrowing, or transaction action is available here.</p>
      </section>
    </>}
  </Modal>;
}

function TokenAge({at}:{at:string}) {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return()=>clearInterval(timer);},[]);
  return <span title={`Token created ${dateTime(at)}`}>{Math.max(0,Math.floor((now-Date.parse(at))/86400_000))}d</span>;
}
function StockCalculator({detail}:{detail:Detail}) {
  const [amount,setAmount]=useState('1');const [basis,setBasis]=useState('token');const [mint,setMint]=useState(detail.variants[0]?.mint??'');
  const row=detail.variants.find(r=>r.mint===mint),listed=row?.rich?.listed;
  const token=row?.displayPrice;
  const valid=basis==='token'?token&&['LIVE','DELAYED'].includes(token.status):listed?.price!=null;
  const price=basis==='token'?token?.priceUsd:listed?.price?.toString();const currency=basis==='token'?'USD':listed?.currency;
  const result=valid&&price&&/^\d{1,15}(\.\d{0,12})?$/.test(amount)?decimal(amount).mul(price).toFixed(2):null;
  return <section className="drawer-section stock-calculator"><h3>Value calculator</h3><p className="canonical-detail-note">Read-only estimate using the selected price and units.</p>
    <label>Asset<select aria-label="Calculator asset" value={mint} onChange={e=>setMint(e.target.value)}>{detail.variants.map(r=><option key={r.mint} value={r.mint}>{r.variant.tokenSymbol} · {r.mint.slice(0,4)}…{r.mint.slice(-4)}</option>)}</select></label>
    <label>Price basis<select aria-label="Calculator price basis" value={basis} onChange={e=>setBasis(e.target.value)}><option value="token">Onchain token price</option><option value="listed">Listed reference / last close</option></select></label>
    <label>{basis==='token'?'Token quantity':'Share quantity'}<input aria-label="Calculator quantity" inputMode="decimal" value={amount} maxLength={28} onChange={e=>setAmount(e.target.value)}/></label>
    <output aria-label="Estimated value">{result!==null?`${Number(result).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} ${currency}`:'A current price and valid quantity are required.'}</output>
    <small>{basis==='token'?dateTime(token?.observedAt??null):dateTime(listed?.observedAt??null)} · excludes fees and slippage</small>
  </section>;
}
