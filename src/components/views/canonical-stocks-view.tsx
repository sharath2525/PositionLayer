'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AlertCircle, ArrowDown, ArrowLeft, ArrowRight, Clock3, ExternalLink,
  Layers3, Search, ShieldCheck } from 'lucide-react';
import type { Portfolio } from '@/domain/types';
import { localStockContext } from '@/domain/stock-intelligence';
import { CanonicalMarketQuerySchema, type CanonicalMarketQuery } from '@/domain/market-api-v2';
import { readBrowserCanonicalDetail, readBrowserCanonicalPage } from '@/services/browser-market-v2';
import { date, time, usdAmount } from '@/components/format';
import { Modal } from '@/components/modal';

type Page = Awaited<ReturnType<typeof readBrowserCanonicalPage>>;
type Row = Page['records'][number];
type Detail = Awaited<ReturnType<typeof readBrowserCanonicalDetail>>;

// Lead with actual token observations. Unpriced identities remain searchable
// and sortable, but should not occupy the first page of a price-focused view.
const initialQuery: CanonicalMarketQuery = CanonicalMarketQuerySchema.parse({
  pageSize: 20, sort: 'availability', direction: 'asc',
});

function CanonicalLogo({ url, symbol }: { url: string | null; symbol: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const safe = url?.startsWith('https://xstocks-metadata.backed.fi/logos/tokens/') ? url : null;
  const show = safe !== null && failed !== safe;
  return <span className="market-avatar" aria-hidden="true"
    data-logo-state={show ? 'verified-provider' : 'initials-fallback'}>
    {show ? <Image src={safe} alt="" width={40} height={40} unoptimized
      referrerPolicy="no-referrer" onError={() => setFailed(safe)}/>
      : symbol.slice(0, 2).toUpperCase()}
  </span>;
}

function identityLabel(row: Row) {
  if (row.verification !== 'issuer-confirmed') return 'Indexed or unresolved · not issuer-confirmed';
  if (row.productClass === 'equity') return 'Issuer-confirmed U.S. equity';
  if (row.productClass === 'etf') return 'Issuer-confirmed U.S. ETF';
  return 'Issuer-confirmed mint · security class unverified';
}

function companyCapLabel(cap: Row['companyCap']) {
  return cap.status === 'estimated' ? usdAmount(cap.valueUsd)
    : cap.status === 'not-applicable' ? 'N/A · ETF' : 'Unavailable';
}

function dateTime(value: string | null) {
  return value ? `${date(value)} · ${time(value)}` : 'Unavailable';
}

export function CanonicalStocksView({ portfolio = null, initialMint = null, onPortfolio, onExposure, onProtect }: {
  portfolio?: Portfolio | null; initialMint?: string | null;
  onPortfolio?: () => void; onExposure?: () => void; onProtect?: () => void;
}) {
  const [draftSearch, setDraftSearch] = useState(initialMint ?? '');
  const [query, setQuery] = useState<CanonicalMarketQuery>({ ...initialQuery, search: initialMint ?? '' });
  const [page, setPage] = useState<Page | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initialOpened = useRef(false);
  const local = useMemo(() => localStockContext(portfolio), [portfolio]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(current => ({ ...current,
      search: draftSearch.trim(), page: 1 })), 250);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) { setLoading(true); setError(null); } });
    void readBrowserCanonicalPage(query, controller.signal)
      .then(result => { if (!controller.signal.aborted) setPage(result); })
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReadVersion(value => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  function update<K extends keyof CanonicalMarketQuery>(key: K, value: CanonicalMarketQuery[K]) {
    setQuery(current => ({ ...current, [key]: value, page: key === 'page' ? Number(value) : 1 }));
  }

  return <section className="stocks-market canonical-market" aria-label="Canonical Solana stock catalog preview">
    <div className="market-source-banner"><div><ShieldCheck size={18}/><span>
      <strong>Canonical catalog preview · read only</strong>
      <small>No wallet required · exact issuer mints · independent price coverage</small>
    </span></div><span>Page visits only read a server snapshot. They never start or restart the price writer.</span></div>

    {page && <>
      <div className="market-summary canonical-summary" aria-label="Canonical market coverage summary">
        <div><span>Searchable identities</span><strong>{page.summary.canonicalCount}</strong><small>{page.summary.multiVariantUnderlyingCount} multi-variant underlyings</small></div>
        <div><span>Unique Solana mints</span><strong>{page.summary.exactMintCount}</strong><small>{page.summary.issuerConfirmedMintCount} exact issuer-confirmed</small></div>
        <div><span>Token prices shown</span><strong>{page.summary.displayPriceUnderlyingCount}</strong><small>{page.summary.displayPriceLiveMintCount} live · {page.summary.displayPriceDelayedMintCount} delayed · {page.summary.displayPriceStaleMintCount} stale</small></div>
        <div><span>Calculation-eligible prices</span><strong>{page.summary.priceAvailableMintCount}</strong><small>{page.summary.eligibleVerifiedMintCount} classified U.S. equity / ETF mints</small></div>
        <div><span>Liquid mints</span><strong>{page.summary.liquidMintCount}</strong><small>Positive exact-mint reported liquidity; not a safety score</small></div>
      </div>
      <details className="canonical-coverage-details"><summary>Full catalog and provider coverage</summary><dl>
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
        <div><dt>Live / delayed / stale / unavailable exact-mint prices</dt><dd>{page.summary.displayPriceLiveMintCount} / {page.summary.displayPriceDelayedMintCount} / {page.summary.displayPriceStaleMintCount} / {page.summary.displayPriceUnavailableMintCount}</dd></div>
        <div><dt>24h onchain token volume</dt><dd>{usdAmount(page.summary.reportedVolume24hUsd)} · {page.summary.reportedVolumeMintCount}/{page.summary.exactMintCount} mints</dd></div>
        <div><dt>Reported tokenized cap coverage</dt><dd>{page.summary.reportedCapMintCount}/{page.summary.exactMintCount} mints</dd></div>
        <div><dt>Company cap available / unavailable / N/A</dt><dd>{page.summary.companyCapAvailableUnderlyingCount} / {page.summary.companyCapUnavailableUnderlyingCount} / {page.summary.companyCapNotApplicableUnderlyingCount}</dd></div>
      </dl></details>
      <div className="canonical-cap-grid">
        <div><span>Covered Solana tokenized cap</span><strong>{usdAmount(page.summary.coveredSolanaTokenizedCap.valueUsd)}</strong>
          <small>{page.summary.coveredSolanaTokenizedCap.eligibleMintCount} of {page.summary.coveredSolanaTokenizedCap.verifiedMintCount} issuer-confirmed mints · {page.summary.coveredSolanaTokenizedCap.status}</small></div>
        <div><span>Separately reported tokenized cap</span><strong>{usdAmount(page.summary.reportedTokenizedCapUsd)}</strong>
          <small>{page.summary.reportedCapMintCount} of {page.summary.exactMintCount} mints · Jupiter Tokens V2 · partial, not company cap</small></div>
      </div>
      <p className="market-cap-note">A reported token cap is not the underlying company&apos;s market cap. {page.summary.coveredSolanaTokenizedCap.status === 'unavailable'
        ? 'Verified Solana-circulating supply is not available, so the derived covered cap remains unavailable.'
        : 'The derived covered cap includes only exact mints with qualified Solana-circulating supply and same-unit market prices.'} Company cap is shown only with qualifying class-aware evidence; ETFs are N/A.</p>
    </>}

    <section className="panel market-panel">
      <div className="market-toolbar">
        <label className="market-search"><Search size={15}/><span className="sr-only">Search canonical catalog</span>
          <input value={draftSearch} maxLength={64} autoComplete="off"
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
          <option value="all">All prices</option><option value="observed">Token price shown</option><option value="available">Calculation-eligible</option><option value="unavailable">No token price</option>
        </select></label>
        <label><span>Sort</span><select aria-label="Sort canonical market" value={query.sort}
          onChange={event => update('sort', event.target.value as CanonicalMarketQuery['sort'])}>
          <option value="availability">Prices first</option><option value="name">Name</option><option value="price">Token price</option><option value="variants">Variants</option><option value="reportedCap">Reported cap</option>
        </select></label>
        <button className="sort-direction" type="button" aria-label={`Sort ${query.direction === 'asc' ? 'descending' : 'ascending'}`}
          onClick={() => update('direction', query.direction === 'asc' ? 'desc' : 'asc')}>
          <ArrowDown size={16} className={query.direction === 'asc' ? 'ascending' : ''}/>
        </button>
      </div>
      {page?.source === 'bundled' && <div className="market-notice" role="status"><AlertCircle size={16}/><span>
        <strong>{page.prices.cycleState === 'idle' && page.summary.priceAttemptedMintCount === 0
          ? 'Price writer is not connected or has not started.' : 'Dated reviewed catalog fallback.'}</strong>
        <small>{page.prices.cycleState === 'idle' && page.summary.priceAttemptedMintCount === 0
          ? 'No Jupiter price batch has run for this preview. A single persistent market host must run the shared writer; page reloads only read its snapshot.'
          : 'Live issuer and price coverage is not proven here. Unknown-class mints are searchable, not counted as verified U.S. stocks or ETFs.'}</small>
      </span></div>}
      {page && page.source !== 'bundled' && page.status !== 'ready' && <div className="market-notice" role="status"><AlertCircle size={16}/><span>
        <strong>Partial market coverage.</strong><small>Catalog: {page.catalog.status}; issuer registry: {page.providers.xstocks}; discovery index: {page.providers.jupiterTag}; Price V3: {page.providers.jupiterPrice}; {page.prices.failedBatchCount} failed batches. Prices retain original timestamps.</small>
      </span></div>}
      {error && page && <div className="market-notice stale" role="status"><AlertCircle size={16}/><span>
        <strong>Latest snapshot read failed.</strong><small>The previously loaded page remains visible; no sample data was substituted.</small>
      </span></div>}
      {loading && page && <div className="market-notice" role="status"><Clock3 size={16}/><span>
        <strong>Refreshing the cached snapshot.</strong><small>Visible identities remain available; this does not start a provider cycle.</small>
      </span></div>}
      {error && !page && <div className="market-empty" role="alert"><AlertCircle size={27}/><h2>Catalog temporarily unavailable</h2><p>{error}</p><button className="button" onClick={() => setReadVersion(value => value + 1)}>Retry snapshot read</button></div>}
      {loading && !page && <div className="market-empty" aria-busy="true"><Clock3 size={25}/><h2>Reading the canonical catalog…</h2><p>No wallet or upstream price request is needed for this read.</p></div>}

      {page && <>
        <div className="market-table-wrap"><table className="market-table canonical-table">
          <caption className="sr-only">Canonical issuer and discovery identities with exact-mint market coverage.</caption>
          <thead><tr><th>Underlying / identity</th><th>Verification</th><th className="numeric">Variants</th>
            <th className="numeric">Exact-mint token price</th><th className="numeric">Liquid mints</th>
            <th className="numeric">24h token volume</th><th className="numeric">Reported token cap</th><th className="numeric">Company cap</th></tr></thead>
          <tbody>{page.records.map(row => <tr key={row.id}>
            <td><button className="market-asset" onClick={() => setSelectedId(row.id)} aria-label={`View ${row.name} variants`}>
              <CanonicalLogo url={row.logoUrl} symbol={row.symbol}/><span><strong>{row.name}</strong><small>{row.symbol} · {row.isin ?? 'ISIN unavailable'}</small>
                {row.variantMints.some(mint => local.held.has(mint)) && <em className="held-badge">In this portfolio</em>}</span></button></td>
            <td><span className={`canonical-verification ${row.verification === 'issuer-confirmed' ? 'confirmed' : ''}`}>{identityLabel(row)}</span></td>
            <td className="numeric">{row.variantCount}</td>
            <td className="numeric"><span className="market-price-value"><strong>{usdAmount(row.displayPrice.priceUsd)}</strong>
              <small>{row.displayPrice.priceUsd ? `Jupiter V3 · ${row.displayPrice.status}${row.price ? ' · calculation-eligible' : ' · display only'} · ${dateTime(row.displayPrice.observedAt)}`
                : `Unavailable · ${row.displayPrice.reason ?? 'no observation'}`}</small></span></td>
            <td className="numeric">{row.liquidMintCount}</td>
            <td className="numeric">{usdAmount(row.reportedVolume24hUsd)}<small className="canonical-cell-note">{row.reportedVolumeMintCount}/{row.variantCount} mints</small></td>
            <td className="numeric">{usdAmount(row.reportedTokenizedCapUsd)}<small className="canonical-cell-note">{row.reportedCapMintCount}/{row.variantCount} mints</small></td>
            <td className="numeric">{companyCapLabel(row.companyCap)}</td>
          </tr>)}</tbody>
        </table></div>
        <div className="market-cards">{page.records.map(row => <button key={row.id} className="market-card" onClick={() => setSelectedId(row.id)} aria-label={`View ${row.name} variants`}>
          <span className="market-card-head"><CanonicalLogo url={row.logoUrl} symbol={row.symbol}/><span><strong>{row.name}</strong><small>{row.symbol} · {identityLabel(row)}</small></span><ArrowRight size={15}/></span>
          <span className="market-card-price"><strong>{usdAmount(row.displayPrice.priceUsd)}</strong><small>{row.displayPrice.priceUsd ? `Price V3 · ${row.displayPrice.status}${row.price ? ' · calculation-eligible' : ' · display only'}` : 'Token price unavailable'}</small></span>
          <span className="market-card-grid"><span>Variants<strong>{row.variantCount}</strong></span><span>Liquid mints<strong>{row.liquidMintCount}</strong></span>
            <span>24h token volume<strong>{usdAmount(row.reportedVolume24hUsd)}</strong></span><span>Reported token cap<strong>{usdAmount(row.reportedTokenizedCapUsd)}</strong></span><span>Company cap<strong>{companyCapLabel(row.companyCap)}</strong></span></span>
          {row.variantMints.some(mint => local.held.has(mint)) && <em className="held-badge">In this portfolio</em>}
        </button>)}</div>
        {!page.records.length && <div className="market-empty"><Search size={26}/><h2>{page.summary.canonicalCount ? 'No identities match these filters' : 'No catalog identities are available'}</h2>
          <p>{page.summary.canonicalCount ? `${page.summary.canonicalCount} identities remain in the catalog. Clear filters to see unpriced and unclassified entries.`
            : 'The issuer catalog is unavailable. No sample identities have been substituted.'}</p>
          {page.summary.canonicalCount > 0 && <button className="button secondary" type="button" onClick={() => { setDraftSearch(''); setQuery(initialQuery); }}>Clear filters</button>}</div>}
        <div className="market-pagination"><span>{page.pagination.total ? `${(page.pagination.page - 1) * page.pagination.pageSize + 1}–${Math.min(page.pagination.page * page.pagination.pageSize, page.pagination.total)} of ${page.pagination.total}` : '0 records'}</span>
          <div><button className="button secondary" disabled={page.pagination.page <= 1 || loading} onClick={() => update('page', page.pagination.page - 1)}><ArrowLeft size={14}/>Previous</button>
            <span>Page {page.pagination.page}{page.pagination.totalPages ? ` of ${page.pagination.totalPages}` : ''}</span>
            <button className="button secondary" disabled={page.pagination.page >= page.pagination.totalPages || loading} onClick={() => update('page', page.pagination.page + 1)}>Next<ArrowRight size={14}/></button></div></div>
        <div className="panel-bottom"><Clock3 size={14}/>Snapshot {page.source} · cycle {page.prices.cycleState} · {page.prices.processedBatches}/{page.prices.totalBatches} batches · last completed {dateTime(page.prices.completedAt)}. Filtering and paging never call providers.</div>
      </>}
    </section>
    {selectedId && <CanonicalDetail assetId={selectedId} local={local} onClose={() => setSelectedId(null)}
      onPortfolio={onPortfolio} onExposure={onExposure} onProtect={onProtect}/>}
  </section>;
}

function CanonicalDetail({ assetId, local, onClose, onPortfolio, onExposure, onProtect }: {
  assetId: string; local: ReturnType<typeof localStockContext>; onClose: () => void;
  onPortfolio?: () => void; onExposure?: () => void; onProtect?: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readBrowserCanonicalDetail(assetId, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Detail unavailable.'); });
    return () => controller.abort();
  }, [assetId]);
  const held = detail?.variants.some(row => local.held.has(row.mint)) ?? false;
  const protectedLoan = detail?.variants.some(row => local.protectedMints.has(row.mint)) ?? false;
  const detailDisplay = detail?.variants.find(row => row.displayPrice.priceUsd !== null)?.displayPrice ?? null;
  return <Modal className="stock-drawer canonical-drawer" title="Canonical asset details" onClose={onClose}>
    {!detail && !error && <p className="drawer-loading" role="status">Loading exact-mint variants from the cached snapshot…</p>}
    {error && <p className="drawer-error" role="alert"><AlertCircle size={14}/>{error}</p>}
    {detail && <>
      <section className="drawer-section"><div className="drawer-section-heading"><span>01</span><h3>Underlying identity</h3></div>
        <strong>{detail.variants[0]?.variant.underlying.symbol ?? detail.variants[0]?.variant.tokenSymbol ?? detail.asset.id}</strong>
        <p className="canonical-detail-note">{detail.asset.verification} · {detail.asset.productClass} · {detail.asset.variantMints.length} exact Solana variant{detail.asset.variantMints.length === 1 ? '' : 's'}</p>
        <dl className="stock-detail-list compact"><dt>Canonical ID</dt><dd><code>{detail.asset.id}</code></dd><dt>Underlying ISIN</dt><dd>{detail.asset.underlyingIsin ?? 'Unresolved'}</dd>
          <dt>Security class</dt><dd>{detail.asset.securityClass ?? 'Unavailable'}</dd><dt>Issuer evidence</dt><dd>{detail.asset.verification === 'issuer-confirmed' ? 'Exact mint declaration' : 'Not issuer-confirmed'}</dd></dl>
      </section>
      <section className="drawer-section"><div className="drawer-section-heading"><span>02</span><h3>Token-market observation</h3></div>
        <div className="drawer-price"><span>Jupiter Price V3 · exact Solana mint · USD</span>
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
