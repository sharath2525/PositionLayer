import type { z } from 'zod';
import type { CanonicalMarketRowSchema } from './market-api-v2';
import { flowPercent } from './stock-rich-data';
type Row=z.infer<typeof CanonicalMarketRowSchema>;
/** Quoted cells still execute formulas in spreadsheet applications. */
export function csvCell(value:unknown) {
  let text=value==null?'':String(value);
  if(/^[\s]*[=+@-]/.test(text)&&!(typeof value==='number'&&Number.isFinite(value)))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function stockCsv(rows:Row[],columns:readonly string[],listed:boolean,history:ReadonlyMap<string,readonly {at:string;value:number}[]>=new Map()) {
  const headers=[...columns,'Price currency','Price basis','Price source','Price observed at','DEX retrieved at','Listed retrieved at','Supply scope','Age basis','Trend basis','Price status'];
  const lines=rows.map(r=>{
    const d=r.rich?.dex,l=r.rich?.listed;
    const values:Record<string,unknown>={Asset:r.tokenSymbol,Company:r.name,Type:r.productClass,Underlying:r.symbol,
      Age:r.marketData?.tokenCreatedAt,Price:listed?l?.price??r.listedData?.referencePrice?.value:r.displayPrice.priceUsd,
      Trend:history.get(r.displayPrice.mint)?.map(p=>`${p.at}:${p.value}`).join('; '),
      '24h %':listed?l?.change:d?.change24h??r.marketData?.change24h?.value,
      'Last 5d':l?.closes.map(p=>`${p.at}:${p.value}`).join('; '),'Toked MC':r.reportedTokenizedCapUsd,MC:r.productClass==='etf'?'N/A':r.listedData?.companyCap?.value,
      FDV:d?.fdv,'Circ Supply':r.rich?.reserve?.circulating??r.marketData?.circulatingPrescaled?.value,
      'Total Supply':r.rich?.holders?.totalSupply??r.marketData?.totalPrescaled?.value,Shares:r.rich?.reserve?.shares,
      Mult:r.marketData?.multiplier?.value,'Solana Mint':r.displayPrice.mint,Token:r.tokenSymbol,
      Market:r.marketStatus,Exchange:r.listingExchange,'Liq $':d?.liquidity??r.marketData?.liquidity?.value,
      'Vol 24h':r.reportedVolume24hUsd,'24h Vol':l?.volume,Flow:flowPercent(r.rich),Holders:r.rich?.holders?.count,
      Official:r.listedData?.referencePrice?.value,'xStocks Q.':r.rich?.quote?.priceUsd??r.issuerContext?.issuerIndicativePriceUsd};
    return [...columns.map(c=>values[c]),listed?l?.currency??r.listedData?.referencePrice?.currency:'USD',listed?'Underlying reference':'Exact-mint token',
      listed?l?'Yahoo Finance':'Jupiter reference':r.displayPrice.source,listed?l?.observedAt??r.listedData?.referencePrice?.observedAt:r.displayPrice.observedAt,
      d?.retrievedAt,l?.retrievedAt,'Circulating: issuer-wide / prescaled; total: raw token / prescaled','Token creation timestamp',history.size?'Observed during this browser session':'Browser session trail unavailable in server export',listed?'Underlying reference':r.displayPrice.status].map(csvCell).join(',');
  });
  return '\uFEFF'+[headers.map(csvCell).join(','),...lines].join('\r\n');
}
