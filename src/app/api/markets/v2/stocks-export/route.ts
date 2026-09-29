import {z} from 'zod';
import {CanonicalMarketQuerySchema,projectCanonicalMarket} from '@/domain/market-api-v2';
import {stockCsv} from '@/domain/stock-export';
import {readCurrentMarketSnapshot} from '@/services/market-v2-reader';
import {currentRichStore} from '@/services/stock-rich-store';
import {marketV2WriterOrigin} from '@/services/market-v2-remote';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const columns=['Asset','Company','Type','Underlying','Age','Price','24h %','Trend','Official','xStocks Q.','Toked MC','FDV','Circ Supply','Total Supply','Shares','Mult','Solana Mint','Market','Exchange','Liq $','Vol 24h','Flow','Holders','Last 5d','MC','24h Vol','Token'] as const;
const schema=z.object({query:CanonicalMarketQuerySchema,columns:z.array(z.enum(columns)).min(1).max(27)}).strict();
export async function POST(request:Request){
  if(request.headers.get('X-PositionLayer-Market-Hop')&&process.env.MARKET_V2_WRITER_ORIGIN)return new Response('Reader loop',{status:508});
  try{
    // Bounded public filters only; no file paths, arbitrary URLs or provider jobs.
    const reader=request.body?.getReader();if(!reader)return new Response('Missing filters',{status:400});
    let size=0,text='';const decoder=new TextDecoder();
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192){await reader.cancel();return new Response('Filters too large',{status:413});}text+=decoder.decode(part.value,{stream:true});}}finally{reader.releaseLock();}
    const input=schema.safeParse(JSON.parse(text+decoder.decode()));if(!input.success)return new Response('Invalid export filters',{status:400});
    const origin=marketV2WriterOrigin();
    if(origin){
      const upstream=await fetch(`${origin}/api/markets/v2/stocks-export`,{method:'POST',body:JSON.stringify(input.data),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-PositionLayer-Market-Hop':'1'}});
      if(!upstream.ok||!upstream.headers.get('content-type')?.includes('text/csv'))throw Error('Export unavailable');
      const source=upstream.body?.getReader();if(!source)throw Error('Empty export');let csv='',bytes=0;
      try{for(;;){const p=await source.read();if(p.done)break;bytes+=p.value.length;if(bytes>3_500_000){await source.cancel();throw Error('Export too large');}csv+=decoder.decode(p.value,{stream:true});}}finally{source.releaseLock();}
      return csvResponse(csv+decoder.decode(),upstream.headers.get('X-Export-Rows')??'0');
    }
    const {read,progress}=await readCurrentMarketSnapshot();const rich=currentRichStore();let csv='',count=0;
    projectCanonicalMarket({read,progress,query:input.data.query,nowMs:Date.now(),rich:rich?.rows,enrichmentVersion:rich?.version,
      onFilteredRows:rows=>{count=rows.length;csv=stockCsv(rows,input.data.columns,input.data.query.view==='listed');}});
    return csvResponse(csv,String(count));
  }catch(error){return new Response(error instanceof SyntaxError?'Invalid export filters':'Export temporarily unavailable',{status:error instanceof SyntaxError?400:503});}
}
function csvResponse(csv:string,count:string){return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="positionlayer-stocks.csv"','X-Export-Rows':/^\d{1,5}$/.test(count)?count:'0','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
