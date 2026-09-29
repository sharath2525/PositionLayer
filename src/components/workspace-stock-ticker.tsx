'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { CanonicalMarketQuerySchema } from '@/domain/market-api-v2';
import { ageCanonicalPage } from '@/domain/market-client-freshness';
import { readBrowserCanonicalPage } from '@/services/browser-market-v2';
import { StocksTicker } from './stocks-ticker';

type Page = Awaited<ReturnType<typeof readBrowserCanonicalPage>>;
type Snapshot = { items: Page['ticker']; snapshotId: string | null };
const Context = createContext<{
  publish: (page: Page) => void;
  selection: { id: string } | null;
} | null>(null);

/** One persistent presentation strip. Stocks supplies its own snapshot; other views
 * read the same public cache, never the upstream providers or wallet services. */
export function WorkspaceStockTicker({ stocksActive, onOpenStocks, children }: {
  stocksActive: boolean; onOpenStocks: () => void; children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ items: [], snapshotId: null });
  const [selection, setSelection] = useState<{ id: string } | null>(null);
  const publish = useCallback((page: Page) => {
    setSnapshot({ items: page.ticker, snapshotId: page.prices.snapshotId });
  }, []);
  useEffect(() => {
    if (stocksActive) return;
    void Promise.resolve().then(() => setSelection(null));
    const controller = new AbortController();
    let latest: Page | null = null;
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState !== 'visible') return;
      reading = true;
      try {
        const page = await readBrowserCanonicalPage(CanonicalMarketQuerySchema.parse({ pageSize: 1 }), controller.signal);
        if (!controller.signal.aborted) { latest = page; publish(ageCanonicalPage(page)); }
      } catch { /* Keep the previous strip; age out unavailable quotes below. */ }
      finally { reading = false; }
    };
    void read();
    const refresh = window.setInterval(() => void read(), 30_000);
    const aging = window.setInterval(() => {
      if (latest) publish(ageCanonicalPage(latest));
      else setSnapshot(current => ({ ...current, items: current.items.filter(item =>
        item.displayPrice.observedAt && Date.now() - Date.parse(item.displayPrice.observedAt) <= 600_000) }));
    }, 5_000);
    return () => { controller.abort(); clearInterval(refresh); clearInterval(aging); };
  }, [stocksActive, publish]);
  return <Context.Provider value={{ publish, selection }}>
    <StocksTicker items={snapshot.items} snapshotId={snapshot.snapshotId} onSelect={id => { setSelection({ id }); onOpenStocks(); }}/>
    {children}
  </Context.Provider>;
}

export function useWorkspaceStockTicker() { return useContext(Context); }
