'use client';

import { useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import type { z } from 'zod';
import type { MarketTickerItemSchema } from '@/domain/market-api-v2';
import { usdAmount } from './format';

/** Presentation only: quotes arrive atomically with the Stocks table response. */
export function StocksTicker({ items, snapshotId, onSelect }: {
  items: z.infer<typeof MarketTickerItemSchema>[]; snapshotId: string | null;
  onSelect: (id: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const quote = (item: typeof items[number]) => <>
    <strong>{item.symbol}</strong>
    <span className={item.change24h && item.change24h.value < 0 ? 'ticker-negative' : 'ticker-positive'}>
      {item.change24h ? `${item.change24h.value >= 0 ? '+' : ''}${item.change24h.value.toFixed(2)}%` : '—'}
    </span><span>{usdAmount(item.displayPrice.priceUsd)}</span>
  </>;
  return <aside className={`stocks-ticker${paused ? ' is-paused' : ''}`} aria-label="Top 20 companies by market cap"
    data-snapshot-id={snapshotId}>
    <strong className="ticker-label" title="Token prices for the largest available companies by reported company cap; currency groups are ranked separately">Top 20</strong>
    <div className="ticker-viewport" tabIndex={0} aria-label="Top companies; focus or hover to pause scrolling">
      {items.length ? <div className="ticker-track" style={{ '--ticker-duration': `${Math.max(35, items.length * 6)}s` } as CSSProperties}>
        <div className="ticker-group">{items.map(item => <button type="button" key={item.id}
          className="ticker-quote" onClick={() => onSelect(item.id)}
          title={`${item.name} · token price · ${item.displayPrice.status} · ${item.displayPrice.observedAt}`}>
          {quote(item)}</button>)}</div>
        <div className="ticker-group ticker-copy" aria-hidden="true">{items.map(item =>
          <span className="ticker-quote" key={item.id}>{quote(item)}</span>)}</div>
      </div> : <span className="ticker-empty">Waiting for available token prices</span>}
    </div>
    <button type="button" className="ticker-pause" onClick={() => setPaused(value => !value)}
      aria-label={paused ? 'Resume ticker' : 'Pause ticker'} aria-pressed={paused}>
      {paused ? <Play size={13}/> : <Pause size={13}/>}</button>
  </aside>;
}
