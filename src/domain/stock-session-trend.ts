import type { DisplayTokenPrice } from './market-price-policy';

export type SessionPoint = { at: string; value: number };
export type SessionHistory = Map<string, SessionPoint[]>;

/** Browser session observations only, one point per new exact-mint timestamp. */
export function recordSessionPrices(history: SessionHistory, page: {
  records: Array<{ displayPrice: DisplayTokenPrice }>; ticker: Array<{ displayPrice: DisplayTokenPrice }>;
}) {
  for (const { displayPrice: price } of [...page.records, ...page.ticker]) {
    if (!price.observedAt || !price.priceUsd || !['LIVE', 'DELAYED'].includes(price.status)) continue;
    const points = history.get(price.mint) ?? [];
    const last = points.at(-1);
    const value = Number(price.priceUsd);
    if (!Number.isFinite(value) || value <= 0 || (last && Date.parse(price.observedAt) <= Date.parse(last.at))) continue;
    history.delete(price.mint);
    history.set(price.mint, [...points.slice(-89), { at: price.observedAt, value }]);
  }
  while (history.size > 300) history.delete(history.keys().next().value!);
}
