'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  Clock3,
  ExternalLink,
  Layers3,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import { decimal } from '@/domain/amounts';
import type {
  PremiumDiscountReason,
  StockMarketDetail,
  StockMarketPage,
  StockMarketQuery,
  StockMarketRecord,
} from '@/domain/stocks';
import type { MarketSourceComparison } from '@/domain/market-observations';
import type { Portfolio } from '@/domain/types';
import { localStockContext } from '@/domain/stock-intelligence';
import { readBrowserStockDetail, readBrowserStockMarket } from '@/services/browser-stocks';
import { amount, date, percent, time, usd, usdAmount } from '@/components/format';
import { Modal } from '@/components/modal';

const initialQuery: StockMarketQuery = {
  search: '',
  assetType: 'all',
  issuer: 'confirmed',
  price: 'all',
  sort: 'liquidity',
  direction: 'desc',
  page: 1,
  pageSize: 20,
};

function change(value: string | null) {
  if (value === null) return '—';
  const number = decimal(value);
  return `${number.gte(0) ? '+' : ''}${number.toFixed(2)}%`;
}

function identityLabel(record: StockMarketRecord) {
  return record.issuerVerified ? 'Issuer-confirmed xStock' : 'Jupiter stocks tag';
}

function StockLogo({ record }: { record: StockMarketRecord }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const officialLogo = record.issuerVerified && record.logoUrl?.startsWith('https://xstocks-metadata.backed.fi/logos/tokens/')
    ? record.logoUrl
    : null;
  const hasVerifiedLogo = Boolean(officialLogo && failedUrl !== officialLogo);
  return <span
    className="market-avatar"
    aria-hidden="true"
    data-logo-state={hasVerifiedLogo ? 'verified-provider' : 'initials-fallback'}
    title={hasVerifiedLogo ? 'Verified issuer logo' : `${record.tokenSymbol} initials fallback`}
  >
    {officialLogo && failedUrl !== officialLogo
      ? <Image src={officialLogo} alt="" width={40} height={40} unoptimized referrerPolicy="no-referrer" onError={() => setFailedUrl(officialLogo)}/>
      : record.tokenSymbol.slice(0, 2).toUpperCase()}
  </span>;
}

const reasonLabel: Record<PremiumDiscountReason, string> = {
  'no-jupiter-price': 'Jupiter price unavailable',
  'no-issuer-price': 'Issuer quote unavailable',
  'stale-jupiter-price': 'Jupiter price is stale',
  'unit-mismatch': 'Display-share unit unresolved',
  'currency-mismatch': 'Quote currency mismatch',
  'pending-multiplier': 'Corporate action pending',
  'trading-halted': 'Issuer trading halted',
  'issuer-unverified': 'Issuer identity unverified',
};

function premium(record: StockMarketRecord) {
  const result = record.intelligence?.premiumDiscount;
  if (!result || result.status !== 'available' || result.valuePct === null) {
    return { short: 'Unavailable', detail: result?.reason ? reasonLabel[result.reason] : 'Open details to refresh' };
  }
  const value = decimal(result.valuePct);
  const direction = value.gt(0) ? 'Premium' : value.lt(0) ? 'Discount' : 'At reference';
  return {
    short: `${direction} ${value.gt(0) ? '+' : value.lt(0) ? '−' : ''}${value.abs().toFixed(2)}%`,
    detail: 'Estimated · not an execution quote',
  };
}

function marketLabel(record: StockMarketRecord) {
  const market = record.intelligence?.market;
  if (!market) return 'Market status unavailable';
  if (market.tradingHalted) return 'Trading halted';
  if (market.period === null) return market.openNow === false ? 'Closed' : 'Market status unavailable';
  return `${market.period === 'market' ? 'Regular' : market.period[0].toUpperCase() + market.period.slice(1)} session${market.openNow === false ? ' · closed' : ''}`;
}

const comparisonReason: Record<NonNullable<MarketSourceComparison['reason']>, string> = {
  'feature-disabled': 'Meteora comparison disabled',
  'no-jupiter-price': 'Jupiter price unavailable',
  'jupiter-not-live': 'Jupiter price is not live',
  'no-meteora-pool': 'No eligible exact-mint Meteora pool',
  'exact-mint-mismatch': 'Exact mint mismatch',
  'currency-mismatch': 'Currency mismatch',
  'unit-mismatch': 'Display-share unit unresolved',
  'multiplier-unresolved': 'Multiplier state unresolved',
  'quote-conversion-unverified': 'Quote conversion unverified',
  'orientation-unresolved': 'Pool orientation unresolved',
  'meteora-stale': 'Meteora observation is stale',
  'low-liquidity': 'Pool liquidity below threshold',
  'invalid-price': 'One source returned an invalid price',
};

function freshness(record: StockMarketRecord) {
  if (record.priceSource === 'jupiter-tokens-v2-reference') return 'REFERENCE';
  return record.marketObservation?.freshness ?? (record.priceUsd === null ? 'UNAVAILABLE' : 'LIVE');
}

function priceSourceLabel(record: StockMarketRecord) {
  if (record.priceSource === 'jupiter-tokens-v2-reference') return 'Tokens V2 · display only';
  if (record.priceSource === 'jupiter-price-v3' || (record.priceSource === undefined && record.priceUsd !== null && record.marketObservation)) return 'Price V3';
  return 'Price unavailable';
}

function DetailSection({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  const id = `stock-detail-${label}`;
  return <section className="drawer-section" aria-labelledby={id}>
    <div className="drawer-section-heading"><span>{label}</span><h3 id={id}>{title}</h3></div>
    {children}
  </section>;
}

type StocksViewProps = {
  portfolio?: Portfolio | null;
  initialMint?: string | null;
  onPortfolio?: () => void;
  onExposure?: () => void;
  onProtect?: () => void;
};

export function StocksView({ portfolio = null, initialMint = null, onPortfolio, onExposure, onProtect }: StocksViewProps) {
  const [draftSearch, setDraftSearch] = useState(initialMint || '');
  const [query, setQuery] = useState<StockMarketQuery>({ ...initialQuery, search: initialMint || '' });
  const [readVersion, setReadVersion] = useState(0);
  const [page, setPage] = useState<StockMarketPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StockMarketRecord | null>(null);
  const initialOpened = useRef(false);
  const local = useMemo(() => localStockContext(portfolio), [portfolio]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(current => ({ ...current, search: draftSearch.trim(), page: 1 })), 250);
    return () => clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(null);
      }
    });
    void readBrowserStockMarket(query, controller.signal)
      .then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Market data could not be loaded.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, readVersion]);

  useEffect(() => {
    if (!initialMint || initialOpened.current || !page) return;
    const match = page.records.find(record => record.mint === initialMint);
    if (match) {
      initialOpened.current = true;
      void Promise.resolve().then(() => setSelected(match));
    }
  }, [initialMint, page]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReadVersion(value => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  function update<K extends keyof StockMarketQuery>(key: K, value: StockMarketQuery[K]) {
    setQuery(current => ({ ...current, [key]: value, page: key === 'page' ? Number(value) : 1 }));
  }

  return <section className="stocks-market" aria-label="Tokenized stock prices on Solana">
    <div className="market-source-banner">
      <div><ShieldCheck size={18}/><span><strong>300 issuer-confirmed Solana assets</strong><small>No wallet required · read only · exact issuer mints</small></span></div>
      <span>One shared server worker rotates six keyless Price V3 batches. Reloads never restart it.</span>
    </div>

    {page && <div className="market-summary" aria-label="Stock market coverage summary">
      <div><span>Verified universe</span><strong>{page.summary.issuerConfirmed}</strong><small>of {page.summary.discovered} exact Solana identities</small></div>
      <div><span>Prices shown</span><strong>{page.summary.priceAvailable}</strong><small>{page.summary.priceV3Available ?? 0} Price V3 · {page.summary.referencePriceAvailable ?? 0} display-only references</small></div>
      <div><span>Liquid markets</span><strong>{page.summary.liquidMarkets}</strong><small>Positive reported onchain liquidity</small></div>
      <div><span>Reported tokenized cap</span><strong>{usd(page.summary.tokenizedMarketCapUsd ?? null)}</strong><small>{page.summary.tokenizedMarketCapCoverage ?? 0} of {page.summary.discovered} mints · not company cap</small></div>
    </div>}
    {page && <p className="market-cap-note">Reported tokenized cap is a partial sum across {page.summary.tokenizedMarketCapCoverage ?? 0} of {page.summary.discovered} exact Solana mints. Original company market cap and its combined total require a separately licensed equity feed; they cannot be derived from tokenized cap. ETFs do not have company market caps.</p>}

    <section className="panel market-panel">
      <div className="market-toolbar">
        <label className="market-search"><Search size={15}/><span className="sr-only">Search tokenized stocks</span><input value={draftSearch} onChange={event => setDraftSearch(event.target.value.slice(0, 64))} maxLength={64} placeholder="Search name, ticker, ISIN, or mint" autoComplete="off"/></label>
        <label><span>Type</span><select aria-label="Asset type" value={query.assetType} onChange={event => update('assetType', event.target.value as StockMarketQuery['assetType'])}><option value="all">All issuer products</option><option value="equity">Verified equity</option><option value="etf">Verified ETF</option><option value="unknown">Type unclassified</option></select></label>
        <label><span>Price</span><select aria-label="Price availability" value={query.price} onChange={event => update('price', event.target.value as StockMarketQuery['price'])}><option value="all">All prices</option><option value="available">Any displayed price</option><option value="v3">Price V3 only</option><option value="reference">Reference only</option><option value="unavailable">No displayed price</option></select></label>
        <label><span>Sort</span><select aria-label="Sort market" value={query.sort} onChange={event => update('sort', event.target.value as StockMarketQuery['sort'])}><option value="name">Name</option><option value="price">Price</option><option value="change24h">24h change</option><option value="liquidity">Liquidity</option><option value="volume24h">24h volume</option><option value="marketCap">Tokenized market cap</option></select></label>
        <button className="sort-direction" aria-label={`Sort ${query.direction === 'desc' ? 'ascending' : 'descending'}`} title={`Sort ${query.direction === 'desc' ? 'ascending' : 'descending'}`} onClick={() => update('direction', query.direction === 'desc' ? 'asc' : 'desc')}><ArrowDown size={16} className={query.direction === 'asc' ? 'ascending' : ''}/></button>
      </div>
      {page && <p className="market-filter-note">The issuer leaves many asset types unclassified. Equity and ETF filters include only source-classified or reviewed exact identities; other assets remain searchable under Type unclassified.</p>}

      {page?.status !== 'ready' && page && <div className={`market-notice ${page.status}`} role="status"><AlertCircle size={16}/><span><strong>{page.status === 'stale' ? 'Showing stale cached market data.' : page.status === 'rate-limited' ? 'Jupiter is rate limited; available cached fields remain visible.' : page.providers.xstocksIntelligence === 'warming' ? 'Core market data is ready; optional details are loading.' : 'Some market sources are unavailable.'}</strong>{page.issues[0] && <small>{page.issues[0]}</small>}</span></div>}
      {error && page && <div className="market-notice stale" role="status"><AlertCircle size={16}/><span><strong>The latest cache read failed.</strong><small>The already-loaded records remain visible. The shared worker continues independently.</small></span></div>}
      {error && !page && <div className="market-empty" role="alert"><span className="state-icon"><AlertCircle size={29}/></span><h2>Market data couldn’t be loaded</h2><p>{error}</p><button className="button" onClick={() => setReadVersion(value => value + 1)}>Try cached market read<RefreshCw size={14}/></button></div>}
      {loading && !page && <div className="market-empty" aria-busy="true"><RefreshCw size={25} className="spin"/><h2>Loading issuer-confirmed Solana assets…</h2><p>The catalog, Lend list, and bounded issuer reads are shared server-side.</p></div>}

      {page && <>
        <div className="market-table-wrap"><table className="market-table phase3-market-table">
          <caption className="sr-only">Issuer-confirmed tokenized stocks with Jupiter price freshness and bounded market evidence.</caption>
          <thead><tr><th>Asset</th><th className="numeric">Token price</th><th className="numeric">24h</th><th>Premium / discount</th><th className="numeric">Liquidity</th><th className="numeric">24h volume</th><th className="numeric">Tokenized market cap</th><th className="numeric">Company market cap</th><th>Lend</th></tr></thead>
          <tbody>{page.records.map(record => {
            const comparison = premium(record);
            const held = local.held.has(record.mint);
            const lend = record.intelligence?.lend;
            return <tr key={record.mint}>
              <td><button className="market-asset" onClick={() => setSelected(record)} aria-label={`View ${record.tokenName} details`}><StockLogo record={record}/><span><strong>{record.tokenName}</strong><small>{record.tokenSymbol} · {marketLabel(record)}</small>{held && <em className="held-badge">In this portfolio</em>}</span></button></td>
              <td className="numeric"><span className="market-price-value"><strong>{usdAmount(record.priceUsd)}</strong><small className={`freshness-${freshness(record).toLowerCase()}`}>{priceSourceLabel(record)} · {freshness(record)}</small></span></td>
              <td className={`numeric market-change ${record.priceChange24hPct && decimal(record.priceChange24hPct).lt(0) ? 'negative' : ''}`}>{change(record.priceChange24hPct)}</td>
              <td><span className={`premium-cell ${record.intelligence?.premiumDiscount.status === 'available' ? 'available' : ''}`}><strong>{comparison.short}</strong><small>{comparison.detail}</small></span></td>
              <td className="numeric">{usd(record.liquidityUsd)}</td><td className="numeric">{usd(record.volume24hUsd)}</td><td className="numeric">{usd(record.tokenizedMarketCapUsd)}</td><td className="numeric" title="No licensed underlying-company market-cap source is configured">—</td>
              <td><span className={`lend-badge ${lend?.status || 'unavailable'}`}>{lend?.status === 'available' ? 'Lend available' : lend?.status === 'not-found' ? 'No verified market' : 'Unavailable'}</span></td>
            </tr>;
          })}</tbody>
        </table></div>

        <div className="market-cards">{page.records.map(record => {
          const comparison = premium(record);
          const lend = record.intelligence?.lend;
          return <button key={record.mint} className="market-card" onClick={() => setSelected(record)} aria-label={`View ${record.tokenName} details`}>
            <span className="market-card-head"><StockLogo record={record}/><span><strong>{record.tokenName}</strong><small>{record.tokenSymbol} · {identityLabel(record)}</small></span><ArrowRight size={15}/></span>
            <span className="market-card-price"><strong>{usdAmount(record.priceUsd)}</strong><small className={record.priceChange24hPct && decimal(record.priceChange24hPct).lt(0) ? 'negative' : ''}>{change(record.priceChange24hPct)} · {priceSourceLabel(record)} · {freshness(record)}</small></span>
            <span className="market-card-grid"><span>Premium / discount<strong>{comparison.short}</strong></span><span>Jupiter Lend<strong>{lend?.status === 'available' ? 'Available' : lend?.status === 'not-found' ? 'No verified market' : 'Unavailable'}</strong></span><span>Liquidity<strong>{usd(record.liquidityUsd)}</strong></span><span>24h volume<strong>{usd(record.volume24hUsd)}</strong></span><span>Tokenized cap<strong>{usd(record.tokenizedMarketCapUsd)}</strong></span><span>Company cap<strong>Unavailable</strong></span><span>Market<strong>{marketLabel(record)}</strong></span></span>
          </button>;
        })}</div>

        {!page.records.length && <div className="market-empty"><Search size={26}/><h2>No matching tokenized stocks</h2><p>Change the bounded search or filters. Missing data is never converted to zero.</p></div>}
        <div className="market-pagination"><span>{page.pagination.total ? `${(page.pagination.page - 1) * page.pagination.pageSize + 1}–${Math.min(page.pagination.page * page.pagination.pageSize, page.pagination.total)} of ${page.pagination.total}` : '0 records'}</span><div><button className="button secondary" disabled={page.pagination.page <= 1 || loading} onClick={() => update('page', page.pagination.page - 1)}><ArrowLeft size={14}/>Previous</button><span>Page {page.pagination.page}{page.pagination.totalPages ? ` of ${page.pagination.totalPages}` : ''}</span><button className="button secondary" disabled={page.pagination.page >= page.pagination.totalPages || loading} onClick={() => update('page', page.pagination.page + 1)}>Next<ArrowRight size={14}/></button></div></div>
        <div className="panel-bottom"><Clock3 size={14}/>Automatic page reads use the shared cache; the worker remains {page.cache.priceWorker.status} with {page.cache.priceWorker.cached}/{page.cache.priceWorker.target} Price V3 records cached.</div>
      </>}
    </section>

    {selected && <StockDetail record={selected} held={local.held.has(selected.mint)} protectedLoan={local.protectedMints.has(selected.mint)} onPortfolio={onPortfolio} onExposure={onExposure} onProtect={onProtect} onClose={() => setSelected(null)}/>} 
  </section>;
}

function StockDetail({ record, held, protectedLoan, onPortfolio, onExposure, onProtect, onClose }: {
  record: StockMarketRecord;
  held: boolean;
  protectedLoan: boolean;
  onPortfolio?: () => void;
  onExposure?: () => void;
  onProtect?: () => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<StockMarketDetail>({ status: 'partial', record, issues: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(null);
      }
    });
    void readBrowserStockDetail(record.mint, controller.signal)
      .then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Detail intelligence is unavailable.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [record.mint]);

  const detail = result.record;
  const evidence = result.marketEvidence;
  const pool = evidence?.meteoraPool;
  const intel = detail.intelligence;
  const reference = premium(detail);
  const vault = intel?.lend.vaults[0];
  const sourceComparison = evidence?.comparison;
  const comparisonText = sourceComparison?.differencePct
    ? `${amount(sourceComparison.differencePct, 2, 4)}% symmetric difference`
    : sourceComparison?.reason
      ? comparisonReason[sourceComparison.reason]
      : 'Bounded comparison is loading';

  return <Modal className="stock-drawer" title={`${detail.tokenSymbol} market details`} onClose={onClose}>
    <DetailSection label="01" title="Identity">
      <div className="drawer-identity"><StockLogo record={detail}/><span><strong>{detail.tokenName}</strong><small>{identityLabel(detail)} · {detail.assetType === 'etf' ? 'ETF' : detail.assetType === 'equity' ? 'Equity' : 'Type unavailable'}</small>{held && <em className="held-badge">Held in this portfolio</em>}</span></div>
      <dl className="stock-detail-list compact"><dt>Mint</dt><dd><code>{detail.mint}</code></dd><dt>Token program</dt><dd><code>{detail.tokenProgram || 'Unavailable'}</code></dd><dt>Decimals</dt><dd>{detail.decimals ?? 'Unavailable'}</dd><dt>Underlying</dt><dd>{detail.issuerVerified ? [detail.underlyingSymbol, detail.underlyingIsin].filter(Boolean).join(' · ') || 'Issuer record unavailable' : 'Not issuer-confirmed'}</dd><dt>Issuer verification</dt><dd>{detail.issuerVerified ? 'Exact Solana deployment mint confirmed' : 'Unverified'}</dd></dl>
    </DetailSection>

    <DetailSection label="02" title="Selected market observation">
      <div className="drawer-price"><span>Selected display source · {priceSourceLabel(detail)}</span><strong>{usdAmount(detail.priceUsd)}</strong><small><b className={`freshness-${freshness(detail).toLowerCase()}`}>{freshness(detail)}</b> · {change(detail.priceChange24hPct)} over 24 hours</small></div>
      <dl className="stock-detail-list compact"><dt>Currency</dt><dd>USD</dd><dt>{detail.priceSource === 'jupiter-tokens-v2-reference' ? 'Reference retrieved' : 'Last successful update'}</dt><dd>{detail.priceUpdatedAt ? `${date(detail.priceUpdatedAt)} · ${time(detail.priceUpdatedAt)}` : 'Unavailable'}</dd><dt>Calculation eligibility</dt><dd>{detail.priceSource === 'jupiter-price-v3' && detail.marketObservation?.eligibleForSensitiveUse ? 'Live · eligible' : 'Display only or unavailable'}</dd><dt>Last validated Price V3</dt><dd>{detail.marketObservation?.retrievedAt ? `${date(detail.marketObservation.retrievedAt)} · ${time(detail.marketObservation.retrievedAt)}` : 'Unavailable'}</dd><dt>Latest Price V3 update</dt><dd>{detail.marketObservation?.updateFailure?.message || (detail.priceSource === 'jupiter-price-v3' ? 'Validated successfully' : 'No eligible Price V3 observation')}</dd></dl>
    </DetailSection>

    <DetailSection label="03" title="Onchain liquidity">
      <div className="drawer-intelligence"><div><span>Meteora verified pool</span><strong>{pool ? `${pool.source === 'meteora-dlmm' ? 'DLMM' : 'DAMM v2'} · ${pool.quoteSymbol}` : 'Unavailable'}</strong><small>{pool ? `${usd(pool.tvlUsd)} TVL · ${usd(pool.volume24hUsd)} 24h volume` : 'No eligible exact-mint USDC pool'}</small></div><div><span>Source comparison</span><strong className={`comparison-${sourceComparison?.status.toLowerCase() || 'not-comparable'}`}>{sourceComparison?.status ?? 'NOT_COMPARABLE'}</strong><small>{comparisonText}</small></div></div>
      <dl className="stock-detail-list compact"><dt>Meteora pair price</dt><dd>{pool ? `${usdAmount(pool.priceUsd)} · ${pool.orientation} · ${pool.quoteSymbol}` : 'Unavailable'}</dd><dt>Liquidity</dt><dd>{pool ? usd(pool.liquidityUsd) : 'Unavailable'}</dd><dt>24h fees</dt><dd>{pool ? usd(pool.fees24hUsd) : 'Unavailable'}</dd><dt>Retrieved</dt><dd>{pool ? `${date(pool.retrievedAt)} · ${time(pool.retrievedAt)}` : 'Unavailable'}</dd></dl>
    </DetailSection>

    <DetailSection label="04" title="Issuer reference">
      <div className="drawer-intelligence"><div><span>Issuer indicative price</span><strong>{usdAmount(intel?.issuerIndicativePriceUsd ?? null)}</strong><small>{intel?.issuerPriceRetrievedAt ? `Retrieved ${time(intel.issuerPriceRetrievedAt)}` : 'Unavailable'}</small></div><div><span>Estimated premium / discount</span><strong>{reference.short}</strong><small>{reference.detail}</small></div></div>
      <dl className="stock-detail-list compact"><dt>Issuer market</dt><dd>{marketLabel(detail)}</dd><dt>Multiplier</dt><dd>{intel?.multiplier.current ?? 'Unavailable'} {intel?.multiplier.status === 'pending' ? `(pending ${intel.multiplier.pending} at ${intel.multiplier.activationAt ? `${date(intel.multiplier.activationAt)} ${time(intel.multiplier.activationAt)}` : 'an unresolved activation time'})` : ''}{intel?.multiplier.reason ? ` · ${intel.multiplier.reason}` : ''}</dd><dt>Tokenized market cap</dt><dd>{usd(detail.tokenizedMarketCapUsd)}</dd><dt>Original company market cap</dt><dd>Unavailable · no verified free equity-cap feed. The tokenized cap above is not the issuer company’s market cap.</dd><dt>Circulating supply</dt><dd>{intel?.supply?.circulating ? `${amount(intel.supply.circulating, 2, 8)} · all xStocks chain deployments` : 'Unavailable'}</dd><dt>Total supply</dt><dd>{intel?.supply?.total ? `${amount(intel.supply.total, 2, 8)} · all xStocks chain deployments` : 'Unavailable'}</dd><dt>Reserve source</dt><dd>{intel?.reserve?.status === 'available' ? `Available · ${intel.reserve.timestamp ? `${date(intel.reserve.timestamp)} ${time(intel.reserve.timestamp)}` : 'timestamp unavailable'}` : 'Unavailable'}</dd><dt>Holder count</dt><dd>{detail.holderCount === null ? 'Unavailable' : amount(String(detail.holderCount), 0, 0)}</dd></dl>
    </DetailSection>

    <DetailSection label="05" title="Local wallet context">
      <div className="wallet-context"><p>{held ? 'This exact mint is present in the locally loaded portfolio.' : 'This exact mint is not present in the locally loaded portfolio.'}</p><p>{protectedLoan ? 'It also appears as collateral in a supported loan.' : 'No supported loan using this exact collateral mint is loaded.'}</p></div>
      <dl className="stock-detail-list compact"><dt>Jupiter Lend</dt><dd>{intel?.lend.status === 'available' ? `Available · vault ${vault?.vaultId} · borrow ${vault?.borrowSymbol}` : intel?.lend.status === 'not-found' ? 'No exact-mint verified market' : 'Provider unavailable'}</dd>{vault && <><dt>Maximum-borrow LTV</dt><dd>{percent(vault.maxBorrowLtv)}</dd><dt>Liquidation threshold</dt><dd>{percent(vault.liquidationThreshold)}</dd></>}</dl>
      {(onPortfolio || (held && onExposure) || (protectedLoan && onProtect)) && <div className="drawer-navigation"><h3>Continue the read-only analysis</h3><div>{onPortfolio && <button className="button secondary" onClick={onPortfolio}><BriefcaseBusiness size={14}/>View portfolio</button>}{held && onExposure && <button className="button secondary" onClick={onExposure}><Layers3 size={14}/>Explore exposure</button>}{protectedLoan && onProtect && <button className="button secondary" onClick={onProtect}><Shield size={14}/>Open Protect</button>}</div></div>}
    </DetailSection>

    <DetailSection label="06" title="Data quality and sources">
      {loading && <p className="drawer-loading" aria-live="polite"><RefreshCw size={14} className="spin"/>Loading bounded detail intelligence…</p>}
      {error && <p className="drawer-error" role="status"><AlertCircle size={14}/>{error} Core market data remains visible.</p>}
      <div className="drawer-sources"><h3>Verified source links</h3>{detail.sources.map(source => <a key={`${source.label}:${source.url}`} href={source.url} target="_blank" rel="noreferrer">{source.label}<ExternalLink size={13}/></a>)}{pool && <a href={pool.sourceUrl} target="_blank" rel="noreferrer">Meteora verified pool<ExternalLink size={13}/></a>}{intel && <><a href={intel.issuerPriceSourceUrl} target="_blank" rel="noreferrer">xStocks issuer reference<ExternalLink size={13}/></a><a href={intel.lend.sourceUrl} target="_blank" rel="noreferrer">Jupiter Lend vault list<ExternalLink size={13}/></a>{intel.reserve && <a href={intel.reserve.sourceUrl} target="_blank" rel="noreferrer">xStocks proof of reserves<ExternalLink size={13}/></a>}</>}</div>
      {(result.issues.length > 0 || detail.warnings.length > 0) && <div className="drawer-warnings"><h3>Warnings and unavailable reasons</h3>{[...result.issues, ...detail.warnings].map((warning, index) => <p key={`${warning}:${index}`}><AlertCircle size={14}/>{warning}</p>)}</div>}
      <p className="modal-foot"><BarChart3 size={14}/>Jupiter is the selected market source. Meteora is separately labeled comparison and liquidity evidence. Issuer marks are non-executable references; no source is averaged, and this is never arbitrage or guaranteed execution.</p>
    </DetailSection>
  </Modal>;
}
