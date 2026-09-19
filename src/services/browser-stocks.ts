'use client';
import { StockMarketDetailSchema, StockMarketPageSchema, type StockMarketDetail, type StockMarketPage, type StockMarketQuery } from '@/domain/stocks';

export async function readBrowserStockMarket(query: StockMarketQuery, signal?: AbortSignal): Promise<StockMarketPage> {
  const params = new URLSearchParams({
    search: query.search,
    assetType: query.assetType,
    issuer: query.issuer,
    price: query.price,
    sort: query.sort,
    direction: query.direction,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  const response = await fetch(`/api/markets/stocks?${params}`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 429) throw Error('Market data is rate limited. Try again after the indicated delay.');
    throw Error(response.status === 400 ? 'The market filters are invalid.' : 'Public stock market data is temporarily unavailable.');
  }
  const parsed = StockMarketPageSchema.safeParse(await response.json());
  if (!parsed.success) throw Error('Market data failed response validation.');
  return parsed.data;
}

export async function readBrowserStockDetail(mint: string, signal?: AbortSignal): Promise<StockMarketDetail> {
  const response = await fetch(`/api/markets/stocks/${encodeURIComponent(mint)}`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw Error(response.status === 404 ? 'This stock is outside the current issuer universe.' : 'Stock intelligence is temporarily unavailable.');
  const parsed = StockMarketDetailSchema.safeParse(await response.json());
  if (!parsed.success) throw Error('Stock detail failed response validation.');
  return parsed.data;
}
