'use client';
import {
  CanonicalMarketDetailSchema, CanonicalMarketPageSchema,
  type CanonicalMarketQuery,
} from '@/domain/market-api-v2';
import { ageCanonicalPage } from '@/domain/market-client-freshness';

const cachedPages=new Map<string,{at:number;page:ReturnType<typeof CanonicalMarketPageSchema.parse>}>();
const key=(query:CanonicalMarketQuery)=>JSON.stringify(query);
export function cachedCanonicalPage(query:CanonicalMarketQuery) {
  const item=cachedPages.get(key(query));
  return item&&Date.now()-item.at<300_000?ageCanonicalPage(item.page):null;
}

export async function readBrowserCanonicalPage(query: CanonicalMarketQuery, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  const response = await fetch(`/api/markets/v2/stocks?${params}`, {
    signal, headers: { accept: 'application/json' }, cache: 'no-store',
  });
  if (!response.ok) throw Error(response.status === 400
    ? 'The catalog search or filters are invalid.' : 'The canonical catalog is temporarily unavailable.');
  const result = CanonicalMarketPageSchema.safeParse(await response.json());
  if (!result.success) throw Error('The canonical market response failed validation.');
  cachedPages.delete(key(query));cachedPages.set(key(query),{at:Date.now(),page:result.data});
  while(cachedPages.size>32)cachedPages.delete(cachedPages.keys().next().value!);
  return result.data;
}

export async function readBrowserCanonicalDetail(assetId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/markets/v2/assets/${encodeURIComponent(assetId)}`, {
    signal, headers: { accept: 'application/json' }, cache: 'no-store',
  });
  if (!response.ok) throw Error(response.status === 404
    ? 'This canonical asset is no longer in the current catalog.' : 'Asset detail is temporarily unavailable.');
  const result = CanonicalMarketDetailSchema.safeParse(await response.json());
  if (!result.success) throw Error('Canonical asset detail failed validation.');
  return result.data;
}
