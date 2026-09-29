import 'server-only';
import { decimal } from '@/domain/amounts';
import { type SolanaStockVariant } from '@/domain/market-types';
import { type StockRichData } from '@/domain/stock-rich-data';

export const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const nonnegative = (v: unknown) => { const n=num(v); return n !== null && n >= 0 ? n : null; };
const positive = (v: unknown) => { const n=num(v); return n !== null && n > 0 ? n : null; };
const integer = (v: unknown) => { const n=nonnegative(v); return n !== null && Number.isSafeInteger(n) ? n : null; };
export const iso = (v: unknown, now=Date.now()) => {
  const n=typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= now + 5000 ? new Date(n).toISOString() : null;
};
const amount = (v: unknown) => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v
  : typeof v === 'number' && Number.isFinite(v) && v>=0 ? decimal(String(v)).toFixed() : null;

export class RichProviderError extends Error {
  constructor(public status: number, public retryAfterMs = 0) { super(`Provider HTTP ${status}`); }
}
export async function richJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    headers: { accept:'application/json' }, cache:'no-store' });
  if (!response.ok) {
    const value=response.headers.get('retry-after');
    const seconds=value ? Number(value) : NaN;
    const wait=Number.isFinite(seconds) ? seconds*1000 : value ? Date.parse(value)-Date.now() : 0;
    throw new RichProviderError(response.status, Math.max(0,Number.isFinite(wait)?wait:0));
  }
  if (!response.body) throw Error('Empty provider response');
  const reader=response.body.getReader(); let text='', bytes=0; const decoder=new TextDecoder();
  try { for (;;) { const {done,value}=await reader.read(); if(done) break;
    bytes+=value.length; if(bytes>8_000_000) throw Error('Provider response too large'); text+=decoder.decode(value,{stream:true});
  } return JSON.parse(text+decoder.decode()); }
  catch(error) { await reader.cancel().catch(()=>{}); throw error; } finally {reader.releaseLock();}
}

export function parseDex(raw: unknown, mints: string[], at: string) {
  const result=new Map<string,StockRichData['dex']>();
  if(!Array.isArray(raw)) throw Error('Invalid DEX response');
  for(const value of raw) {
    const p=obj(value), base=obj(p.baseToken), liq=obj(p.liquidity), volume=obj(p.volume), tx=obj(obj(p.txns).h24);
    const mint=String(base.address??'');
    if(p.chainId!=='solana'||!mints.includes(mint)||typeof p.pairAddress!=='string'
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.pairAddress)) continue;
    const liquidity=nonnegative(liq.usd), previous=result.get(mint);
    if(previous && ((previous.liquidity??0)>(liquidity??0)
      || ((previous.liquidity??0)===(liquidity??0)&&previous.pair.localeCompare(p.pairAddress)<=0))) continue;
    result.set(mint,{retrievedAt:at,sourceUrl:`https://dexscreener.com/solana/${p.pairAddress}`,pair:p.pairAddress,
      priceUsd:typeof p.priceUsd==='string'&&/^\d+(\.\d+)?$/.test(p.priceUsd)?positive(Number(p.priceUsd)):null,
      liquidity, volume24h:nonnegative(volume.h24),change24h:num(obj(p.priceChange).h24),
      marketCap:nonnegative(p.marketCap),fdv:nonnegative(p.fdv),buys:integer(tx.buys),sells:integer(tx.sells),
      pairCreatedAt:iso(p.pairCreatedAt,Date.parse(at))});
  }
  return result;
}
export function parseReserve(raw: unknown, at: string): { symbol:string; value: NonNullable<StockRichData['reserve']> } | null {
  const p=obj(raw); if(typeof p.symbol!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(p.symbol))return null;
  const circulating=amount(p.circulatingSupply),shares=amount(p.sharesHeld);
  if(circulating===null&&shares===null)return null;
  return {symbol:p.symbol,value:{retrievedAt:at,observedAt:iso(p.timestamp,Date.parse(at)),circulating,shares,
    custodians:Array.isArray(p.holdings)?[...new Set(p.holdings.flatMap(h=>typeof obj(h).provider==='string'?[String(obj(h).provider).slice(0,100)]:[]))].slice(0,100):[],
    sourceUrl:`https://api.xstocks.fi/api/v2/public/proof-of-reserves/${encodeURIComponent(p.symbol)}`}};
}
export function parseHolders(raw: unknown, mint: string, at: string): StockRichData['holders'] {
  const p=obj(raw), t=obj(p.token); const count=integer(p.totalHolders);
  if(p.mint!==mint||count===null)return null;
  const supply=integer(t.supply),decimals=integer(t.decimals);
  return {count,retrievedAt:at,observedAt:iso(p.detectedAt,Date.parse(at)),
    totalSupply:supply!==null&&decimals!==null&&decimals<=30?decimal(String(supply)).div(decimal('10').pow(decimals)).toFixed():null,
    sourceUrl:`https://api.rugcheck.xyz/v1/tokens/${mint}/report`};
}

/** Exchange-specific aliases from the issuer catalog; no country-wide default
 * (the prototype maps every German security to VOW3). */
export function listedSymbol(v: SolanaStockVariant): string | null {
  const s=v.underlying.symbol,c=v.underlying.listingCountry,e=v.listing?.exchange?.toUpperCase();
  if(!s||!/^[A-Za-z0-9.^-]{1,24}$/.test(s))return null;
  const aliases: Record<string,string>={'GB:ULVRL':'ULVR.L','GB:HSBAL':'HSBA.L','DE:VOW3D':'VOW3.DE','ES:TEFE':'TEF.MC'};
  if(aliases[`${c}:${s}`])return aliases[`${c}:${s}`];
  if(c==='GB'&&e==='LSE'&&/^[A-Z0-9]+L$/.test(s))return s==='BTL'?'BT-A.L':`${s.slice(0,-1)}.L`;
  if(c==='US'&&['NASDAQ','NYSE','ARCA','NYSEARCA','NYSE ARCA','AMEX','BATS','XNYS','XNAS','ARCX'].includes(e??''))return s.replace('.', '-');
  if(c==='HK'&&/^\d{1,5}$/.test(s))return `${s.padStart(4,'0')}.HK`;
  return null;
}
// Issuer trading.currency is the token's quote currency, not necessarily the
// native listing's currency. Validate against the qualified exchange instead.
export function listedCurrency(v:SolanaStockVariant):string|null {
  const symbol=listedSymbol(v);if(!symbol)return null;
  return symbol.endsWith('.L')?'GBP':symbol.endsWith('.HK')?'HKD':symbol.endsWith('.DE')||symbol.endsWith('.MC')?'EUR':'USD';
}
export function parseListed(raw: unknown, symbol: string, expectedCurrency: string | null, at: string): StockRichData['listed'] {
  const roots=obj(obj(raw).chart).result;if(!Array.isArray(roots))return null;
  const r=obj(roots[0]),m=obj(r.meta),q=obj((obj(r.indicators).quote as unknown[]|undefined)?.[0]);
  if(m.symbol!==symbol||typeof m.currency!=='string'||!['EQUITY','ETF'].includes(String(m.instrumentType)))return null;
  const exchange=String(m.exchangeName??'');
  if(exchange&&((symbol.endsWith('.L')&&!['LSE','LONDON'].includes(exchange))
    ||(symbol.endsWith('.HK')&&!['HKG','HKSE'].includes(exchange))
    ||(symbol.endsWith('.DE')&&!['GER','XETRA'].includes(exchange))
    ||(symbol.endsWith('.MC')&&!['MCE','BME'].includes(exchange))))return null;
  const currency=m.currency==='GBp'?'GBP':m.currency;
  if(!/^[A-Z]{3}$/.test(currency)||(expectedCurrency&&currency!==expectedCurrency))return null;
  const factor=m.currency==='GBp'?100:1;
  const prices=Array.isArray(q.close)?q.close:[], timestamps=Array.isArray(r.timestamp)?r.timestamp:[];
  const closes=prices.flatMap((p,i)=>{const value=positive(p),t=typeof timestamps[i]==='number'?iso(timestamps[i]*1000,Date.parse(at)):null;
    return value!==null&&t?[{value:value/factor,at:t}]:[];}).slice(-5);
  const previous=closes.length>=2?closes[closes.length-2].value:null;
  const last=closes.at(-1)?.value??null;
  const live=positive(m.regularMarketPrice);
  const regular=obj(obj(m.currentTradingPeriod).regular),start=positive(regular.start),end=positive(regular.end);
  const session=start&&end&&end>start&&end-start<=86400&&end*1000<Date.parse(at)+8*86400_000
    ?{startsAt:new Date(start*1000).toISOString(),endsAt:new Date(end*1000).toISOString()}:null;
  return {symbol,currency,exchange:String(m.fullExchangeName??m.exchangeName??'').slice(0,80),
    kind:m.instrumentType==='ETF'?'etf':'equity',price:live!==null?live/factor:last,
    session,
    observedAt:typeof m.regularMarketTime==='number'?iso(m.regularMarketTime*1000,Date.parse(at)):closes.at(-1)?.at??null,
    change:previous!==null&&last!==null?(last-previous)/previous*100:null,
    volume:nonnegative(m.regularMarketVolume)??(Array.isArray(q.volume)?nonnegative(q.volume.at(-1)):null),
    closes,retrievedAt:at,sourceUrl:`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`};
}
