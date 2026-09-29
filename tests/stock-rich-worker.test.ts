import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mock=vi.hoisted(()=>({allowed:true,rows:new Map(),read:vi.fn(),put:vi.fn()}));
vi.mock('@/services/market-durable-store',()=>({marketWriterAllowed:()=>mock.allowed}));
vi.mock('@/services/stock-rich-store',()=>({openRichStore:()=>({rows:mock.rows}),currentRichStore:()=>({rows:mock.rows,put:mock.put})}));
vi.mock('@/services/market-v2-reader',()=>({readCurrentMarketSnapshot:async()=>({read:{snapshot:null}})}));
vi.mock('@/services/market-legacy-reader',()=>({legacySnapshotRecords:()=>[]}));
vi.mock('@/services/stocks-market',()=>({refreshStockContextFromWorker:async()=>{}}));
vi.mock('@/adapters/market/stock-rich-providers',async importOriginal=>({...await importOriginal<typeof import('@/adapters/market/stock-rich-providers')>(),richJson:mock.read}));
import {startStockRichWorker,stopStockRichWorker,stockRichWorkerStatus} from '@/services/stock-rich-worker';
import {RichProviderError} from '@/adapters/market/stock-rich-providers';
import {normalizeStockUniverse} from '@/adapters/market/stocks';
import {adaptLegacyXstockRecord} from '@/domain/market-identity-adapter';
import {buildUniverseRegistry} from '@/domain/universe-registry';
const at='2026-09-28T10:00:00.000Z',mint='XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const variant=adaptLegacyXstockRecord(normalizeStockUniverse([{symbol:'TESTx',name:'Test stock',underlying:{symbol:'TEST',listingCountry:'US',type:'Equity'},deployments:[{address:mint,network:'Solana'}]}],[],at)[0]).variant;
const catalog={id:'worker-fixture',publishedAt:at,registry:buildUniverseRegistry({reviewed:[],now:at,reads:[{provider:'xstocks' as const,status:'ready' as const,records:[{variant,supply:null}],lastSuccess:at,lastAttempt:at,retryAfter:null,issues:[]}]})};
function setup(){vi.useFakeTimers();vi.setSystemTime(at);mock.allowed=true;mock.rows.clear();mock.put.mockReset();mock.read.mockReset();
  mock.read.mockImplementation(async(url:string)=>url.includes('proof-of-reserves')?{nodes:[],page:{currentPage:0,hasNextPage:false}}:url.includes('dexscreener')?[]:{});}
afterEach(async()=>{await stopStockRichWorker();vi.useRealTimers();});
describe('independent optional-provider queues',()=>{
  it('serverless/reader mode cannot start providers',async()=>{setup();mock.allowed=false;startStockRichWorker(catalog);await vi.advanceTimersByTimeAsync(5000);expect(mock.read).not.toHaveBeenCalled();});
  it('deduplicates starts and permits only one pending DEX request while other queues progress',async()=>{setup();let release:((value:unknown)=>void)|undefined;
    const normal=mock.read.getMockImplementation()!;mock.read.mockImplementation((url:string)=>url.includes('dexscreener')?new Promise(resolve=>{release=resolve;}):normal(url));
    startStockRichWorker(catalog);startStockRichWorker(catalog);await vi.advanceTimersByTimeAsync(10000);
    expect(mock.read.mock.calls.filter(([url])=>url.includes('dexscreener'))).toHaveLength(1);
    expect(mock.read.mock.calls.some(([url])=>url.includes('rugcheck'))).toBe(true);
    release!([]);await vi.advanceTimersByTimeAsync(1000);await stopStockRichWorker();const count=mock.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);expect(mock.read).toHaveBeenCalledTimes(count);
  });
  it('honors Retry-After and retries failed requests before the success TTL',async()=>{setup();let calls=0;
    const normal=mock.read.getMockImplementation()!;mock.read.mockImplementation(async(url:string)=>{
      if(url.includes('dexscreener')){calls++;if(calls===1)throw new RichProviderError(429,65000);return [];}return normal(url);});
    startStockRichWorker(catalog);await vi.advanceTimersByTimeAsync(64000);expect(calls).toBe(1);
    expect(stockRichWorkerStatus().providers.dex.error).toBe('Provider HTTP 429');
    await vi.advanceTimersByTimeAsync(3000);expect(calls).toBe(2);expect(stockRichWorkerStatus().providers.dex.error).toBeNull();
  });
});
