import 'server-only';
import { StockRichDataSchema, type StockRichData, type RichKind } from '@/domain/stock-rich-data';
import type { CatalogVersion } from '@/domain/market-snapshot';
import { marketWriterAllowed } from './market-durable-store';
import { openRichStore, currentRichStore } from './stock-rich-store';
import { richJson, RichProviderError, obj, parseDex, parseReserve, parseHolders, parseListed, listedSymbol, listedCurrency } from '@/adapters/market/stock-rich-providers';

type Job = 'dex'|'reserve'|'quote'|'holders'|'listed'|'legacy';
type State = { controller:AbortController; catalog:CatalogVersion; running:Set<Job>; due:Map<Job,number>;
  attempts:Map<string,number>; errors:Map<Job,string>; failures:Map<Job,number>; timer:ReturnType<typeof setTimeout>|null; reservePage:number; stopped:boolean; issuerNext:number; pending:Set<Promise<void>> };
type Root=typeof globalThis & { __stockRichWorker?:State };
const root=globalThis as Root;
const spacing: Record<Job,number>={dex:1500,reserve:2500,quote:3000,holders:6500,listed:3000,legacy:30_000};
const ttl:Record<RichKind,number>={dex:120_000,reserve:3600_000,quote:15*60_000,holders:24*3600_000,listed:3600_000};
function save(mint:string,kind:RichKind,value:StockRichData[RichKind]) {
  if(!value)return;
  const store=currentRichStore(); if(!store)return;
  const old=store.rows.get(mint)??StockRichDataSchema.parse({mint});
  store.put([{...old,[kind]:value}]);
}
function candidates(s:State,kind:RichKind,limit:number) {
  const store=currentRichStore();const now=Date.now();
  return s.catalog.registry.entries.filter(e=>e.catalogState==='active'&&e.conflicts.length===0&&e.variant.verification==='issuer-confirmed')
    .map(e=>({v:e.variant,liquid:(store?.rows.get(e.variant.mint)?.dex?.liquidity??Number(e.variant.reportedLiquidityUsd??0))>0,last:Math.max(s.attempts.get(`${kind}:${e.variant.mint}`)??0,
      kind==='listed'&&store?.rows.get(e.variant.mint)?.listed&&!store.rows.get(e.variant.mint)?.listed?.session?0:Date.parse(store?.rows.get(e.variant.mint)?.[kind]?.retrievedAt??'')||0)}))
    .filter(e=>now-e.last>=ttl[kind])
    // Oldest first is starvation-free; positive-liquidity mints win initial ties.
    .sort((a,b)=>a.last-b.last||Number(b.liquid)-Number(a.liquid)||a.v.mint.localeCompare(b.v.mint))
    .slice(0,limit).map(e=>{s.attempts.set(`${kind}:${e.v.mint}`,now);return e.v;});
}
async function work(s:State,job:Job) {
  const signal=s.controller.signal,at=()=>new Date().toISOString();
  if(job==='dex') {
    const batch=candidates(s,'dex',30);if(!batch.length)return;
    const mints=batch.map(v=>v.mint);
    const parsed=parseDex(await richJson(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`,signal),mints,at());
    for(const [mint,value] of parsed)if(!signal.aborted)save(mint,'dex',value);
  } else if(job==='reserve') {
    const data=obj(await richJson(`https://api.xstocks.fi/api/v2/public/proof-of-reserves?page=${s.reservePage}&pageSize=100`,signal));
    if(!Array.isArray(data.nodes)||obj(data.page).currentPage!==s.reservePage)throw Error('Invalid reserve page');
    const bySymbol=new Map(s.catalog.registry.entries.filter(e=>e.variant.verification==='issuer-confirmed'&&e.conflicts.length===0).map(e=>[e.variant.tokenSymbol,e.variant.mint]));
    for(const raw of data.nodes) {const p=parseReserve(raw,at()),mint=p?bySymbol.get(p.symbol):null;
      if(p&&mint&&!signal.aborted)save(mint,'reserve',p.value);}
    if(obj(data.page).hasNextPage===true&&s.reservePage<24)s.reservePage++;
    else{s.reservePage=0;s.due.set(job,Date.now()+ttl.reserve);}
  } else if(job==='quote') {
    const v=candidates(s,'quote',1)[0];if(!v)return;
    const url=`https://api.xstocks.fi/api/v2/public/assets/${encodeURIComponent(v.tokenSymbol)}/price-data`;
    const p=obj(await richJson(url,signal));
    if(typeof p.quote==='number'&&Number.isFinite(p.quote)&&p.quote>0&&!signal.aborted)save(v.mint,'quote',{priceUsd:p.quote,retrievedAt:at(),sourceUrl:url});
  } else if(job==='holders') {
    const v=candidates(s,'holders',1)[0];if(!v)return;
    const p=parseHolders(await richJson(`https://api.rugcheck.xyz/v1/tokens/${v.mint}/report`,signal),v.mint,at());
    if(!signal.aborted)save(v.mint,'holders',p);
  } else if(job==='listed') {
    const batch=candidates(s,'listed',20).filter(v=>listedSymbol(v));if(!batch.length)return;
    const symbols=[...new Set(batch.map(v=>listedSymbol(v)!))];
    const url=`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&interval=1d&range=5d`;
    const result=obj(obj(await richJson(url,signal)).spark).result;
    if(!Array.isArray(result))throw Error('Invalid listed history response');
    for(const raw of result){const item=obj(raw),v=batch.find(v=>listedSymbol(v)===item.symbol);if(!v)continue;
      const p=parseListed({chart:{result:item.response}},String(item.symbol),listedCurrency(v),at());
      if(p&&!signal.aborted)for(const e of s.catalog.registry.entries)if(e.conflicts.length===0&&e.variant.verification==='issuer-confirmed'&&listedSymbol(e.variant)===item.symbol&&listedCurrency(e.variant)===p.currency)save(e.variant.mint,'listed',{...p,sourceUrl:url});
    }
  } else {
    // Preserve lending/pool detail collection, but never await it in the price loop.
    const [{readCurrentMarketSnapshot},{legacySnapshotRecords},{refreshStockContextFromWorker}]=await Promise.all([
      import('./market-v2-reader'),import('./market-legacy-reader'),import('./stocks-market')]);
    const snapshot=(await readCurrentMarketSnapshot()).read.snapshot;
    if(snapshot&&!signal.aborted){const records=legacySnapshotRecords(snapshot).sort((a,b)=>(s.attempts.get(`legacy:${a.mint}`)??0)-(s.attempts.get(`legacy:${b.mint}`)??0));
      const record=records[0];if(record){s.attempts.set(`legacy:${record.mint}`,Date.now());await refreshStockContextFromWorker(record);}}
  }
}
function pump(s:State) {
  if(s.stopped||s.controller.signal.aborted)return;
  for(const job of Object.keys(spacing) as Job[]) {
    if(s.running.has(job)||Date.now()<(s.due.get(job)??0))continue;
    if((job==='quote'||job==='reserve')&&Date.now()<s.issuerNext)continue;
    if(job==='quote'||job==='reserve')s.issuerNext=Date.now()+3500;
    s.running.add(job);
    const started=Date.now();
    const task=work(s,job).then(()=>{s.errors.delete(job);s.failures.delete(job);}).catch(error=>{
      if(error instanceof RichProviderError&&[400,404,422].includes(error.status)){
        // An unsupported instrument must not back off every other instrument.
        for(const [key,time] of s.attempts)if(key.startsWith(`${job}:`)&&time>=started)s.attempts.set(key,Date.now()-(ttl[job as RichKind]??60_000)+1800_000);
        s.errors.set(job,error.message);return;
      }
      const failures=(s.failures.get(job)??0)+1;s.failures.set(job,failures);
      // Failed requests retry after provider backoff, not after a successful field's TTL.
      for(const [key,time] of s.attempts)if(key.startsWith(`${job}:`)&&time>=started)s.attempts.set(key,Date.now()-(ttl[job as RichKind]??60_000)+60_000);
      s.errors.set(job,error instanceof Error?error.message:'Provider unavailable');
      s.due.set(job,Date.now()+Math.max(Math.min(900_000,30_000*2**Math.min(failures-1,5)),error instanceof RichProviderError?error.retryAfterMs:0)+Math.floor(Math.random()*1000));
      if((job==='quote'||job==='reserve')&&error instanceof RichProviderError&&error.status===429)s.issuerNext=Math.max(s.issuerNext,s.due.get(job)??0);
    }).finally(()=>{s.pending.delete(task);s.running.delete(job);s.due.set(job,Math.max(s.due.get(job)??0,Date.now()+spacing[job]));});
    s.pending.add(task);
  }
  s.timer=setTimeout(()=>pump(s),1000);s.timer.unref?.();
}
/** Called only after the price writer acquires its persistent-volume lock. */
export function startStockRichWorker(catalog:CatalogVersion) {
  if(!marketWriterAllowed()||process.env.MARKET_ENRICHMENT_ENABLED==='false')return;
  openRichStore(process.env.MARKET_SNAPSHOT_DIR??'.market-data');
  if(root.__stockRichWorker&&!root.__stockRichWorker.stopped){root.__stockRichWorker.catalog=catalog;return;}
  const s:State={catalog,controller:new AbortController(),running:new Set(),due:new Map(),attempts:new Map(),errors:new Map(),failures:new Map(),timer:null,reservePage:0,stopped:false,issuerNext:0,pending:new Set()};
  root.__stockRichWorker=s;pump(s);
}
export async function stopStockRichWorker(){const s=root.__stockRichWorker;if(s){s.stopped=true;s.controller.abort();if(s.timer)clearTimeout(s.timer);await Promise.allSettled([...s.pending]);}}
export function stockRichWorkerStatus(){const s=root.__stockRichWorker;return {running:Boolean(s&&!s.stopped),
  version:currentRichStore()?.version??null,covered:currentRichStore()?.rows.size??0,
  providers:s?Object.fromEntries((Object.keys(spacing) as Job[]).map(k=>[k,{active:s.running.has(k),retryAt:s.due.get(k)??null,error:s.errors.get(k)??null}])):{}};}
