import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseDex, parseReserve, parseHolders, parseListed, listedSymbol, listedCurrency } from '@/adapters/market/stock-rich-providers';
import { StockRichDataSchema, ageRichData, flowPercent, listedSession } from '@/domain/stock-rich-data';
import { StockRichStore } from '@/services/stock-rich-store';
import { csvCell } from '@/domain/stock-export';
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';
import { buildUniverseRegistry } from '@/domain/universe-registry';
import { CanonicalMarketQuerySchema,projectCanonicalMarket } from '@/domain/market-api-v2';
import { readMarketSnapshot } from '@/services/market-snapshot-reader';
import { MemoryMarketSnapshotStore } from '@/services/market-snapshot-store';
import sample from './fixtures/market-phase1/jupiter-public-sample.json';
const mint=sample.requested[0],pair=sample.requested[1], at='2026-09-28T10:00:00.000Z',now=Date.parse(at);
const rawPair={chainId:'solana',pairAddress:pair,baseToken:{address:mint},priceUsd:'20',
  liquidity:{usd:1000},volume:{h24:2500},priceChange:{h24:-2},txns:{h24:{buys:60,sells:40}},marketCap:40000,fdv:80000};
const dex=parseDex([rawPair],[mint],at).get(mint)!;
function variant() {return adaptLegacyXstockRecord(normalizeStockUniverse([{symbol:'TESTx',name:'Test stock',
  underlying:{symbol:'TEST',isin:'US0000000001',type:'Equity',listingCountry:'US'},
  deployments:[{address:mint,network:'Solana'}]}],[],at)[0]).variant;}
describe('Phase 2 enrichment safety and recovery',()=>{
  it('selects only the exact Solana base mint and highest-liquidity pool without summing duplicates',()=>{
    const data=parseDex([{...rawPair,chainId:'ethereum',liquidity:{usd:99999}},
      {...rawPair,baseToken:{address:pair},quoteToken:{address:mint}},rawPair,{...rawPair,liquidity:{usd:2}}],[mint],at);
    expect(data.size).toBe(1);expect(data.get(mint)).toMatchObject({liquidity:1000,volume24h:2500,marketCap:40000,fdv:80000});
  });
  it('keeps absent fields absent and distinguishes zero trading flow from missing flow',()=>{
    const value=parseDex([{...rawPair,marketCap:undefined,fdv:undefined,txns:{h24:{buys:0,sells:0}}}],[mint],at).get(mint)!;
    expect(value.marketCap).toBeNull();expect(value.fdv).toBeNull();expect(flowPercent(StockRichDataSchema.parse({mint,dex:value}))).toBeNull();
    expect(flowPercent(StockRichDataSchema.parse({mint,dex}))).toBe(60);
  });
  it('preserves issuer decimal precision, zero shares and original observation time',()=>{
    expect(parseReserve({symbol:'TESTx',timestamp:at,circulatingSupply:'0.00000000000001',sharesHeld:'0',holdings:[]},at)?.value)
      .toMatchObject({circulating:'0.00000000000001',shares:'0',observedAt:at});
  });
  it('rejects wrong-mint holder reports and does not round unsafe integer supply',()=>{
    expect(parseHolders({mint:pair,totalHolders:4},mint,at)).toBeNull();
    expect(parseHolders({mint,totalHolders:0,token:{supply:Number.MAX_SAFE_INTEGER+2,decimals:6}},mint,at))
      .toMatchObject({count:0,totalSupply:null});
  });
  it('normalizes pence and validates listing symbol/currency before exposing history',()=>{
    const raw={chart:{result:[{meta:{symbol:'TEST.L',currency:'GBp',instrumentType:'EQUITY',regularMarketPrice:12000,regularMarketVolume:500},
      timestamp:[now/1000-86400,now/1000],indicators:{quote:[{close:[10000,12000]}]}}]}};
    const listed=parseListed(raw,'TEST.L','GBP',at)!;
    expect(listed.price).toBe(120);expect(listed.closes.map(c=>c.value)).toEqual([100,120]);expect(listed.change).toBe(20);expect(listed.volume).toBe(500);
    expect(parseListed(raw,'OTHER.L','GBP',at)).toBeNull();expect(parseListed(raw,'TEST.L','USD',at)).toBeNull();
    const v=variant();v.underlying.listingCountry='DE';v.underlying.symbol='UNKNOWN';expect(listedSymbol(v)).toBeNull();
  });
  it('ages each independent field and rejects future retrievals',()=>{
    const data=StockRichDataSchema.parse({mint,dex,reserve:parseReserve({symbol:'TESTx',sharesHeld:'3'},at)!.value});
    expect(ageRichData(data,now+31*60000)).toMatchObject({dex:null,reserve:data.reserve});
    expect(ageRichData(data,now-6000)).toMatchObject({dex:null,reserve:null});
  });
  it('qualifies foreign symbols by exchange and keeps token quote currency separate',()=>{
    const v=variant();v.underlying.listingCountry='GB';v.underlying.symbol='BARCL';
    v.listing={currency:'USD',exchange:'LSE',period:null,openNow:null,nextChangeAt:null};
    expect(listedSymbol(v)).toBe('BARC.L');expect(listedCurrency(v)).toBe('GBP');
    const raw={chart:{result:[{meta:{symbol:'BARC.L',currency:'GBp',instrumentType:'EQUITY',exchangeName:'NASDAQ'}}]}};
    expect(parseListed(raw,'BARC.L','GBP',at)).toBeNull();
  });
  it('uses actual exchange sessions and expires them instead of assuming token trading hours',()=>{
    const listed=parseListed({chart:{result:[{meta:{symbol:'TEST',currency:'USD',instrumentType:'EQUITY',regularMarketPrice:20,
      currentTradingPeriod:{regular:{start:now/1000-3600,end:now/1000+3600}}}}]}},'TEST','USD',at)!;
    expect(listedSession(listed,now).status).toBe('open');
    expect(listedSession(listed,now-7200000).status).toBe('closed');
    expect(listedSession(listed,now+14*3600000).status).toBe('unknown');
  });
  it('restores the last validated enrichment after restart and falls back past a corrupt newest row',()=>{
    const dir=mkdtempSync(join(tmpdir(),'pl-rich-'));let store:StockRichStore|null=null;
    try{store=new StockRichStore(dir);store.put([StockRichDataSchema.parse({mint,dex})]);const version=store.version;store.close();store=null;
      const db=new DatabaseSync(join(dir,'enrichment.sqlite'));db.prepare('INSERT INTO observations(mint,payload) VALUES (?,?)').run(mint,'broken');db.close();
      store=new StockRichStore(dir);expect(store.rows.get(mint)?.dex?.retrievedAt).toBe(at);expect(store.version).toBe(version);
      expect(()=>store!.put([{mint,dex:{...dex,marketCap:-1}} as never])).toThrow();expect(store.rows.get(mint)?.dex?.marketCap).toBe(40000);
    }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('joins enrichment before filtering/sorting and keeps DEX display out of sensitive price calculations',async()=>{
    const v=variant();const registry=buildUniverseRegistry({reviewed:[],now:at,reads:[{provider:'xstocks',status:'ready',records:[{variant:v,supply:null}],lastSuccess:at,lastAttempt:at,retryAfter:null,issues:[]}]});
    const catalog={id:'rich-test',publishedAt:at,registry};const store=new MemoryMarketSnapshotStore();
    const read=await readMarketSnapshot({store,bundledCatalog:catalog,nowMs:now});
    const rich=new Map([[mint,StockRichDataSchema.parse({mint,dex})]]);
    const page=projectCanonicalMarket({read,query:CanonicalMarketQuerySchema.parse({watchlist:mint,sort:'volume'}),nowMs:now,rich});
    expect(page.records[0].displayPrice).toMatchObject({source:'dexscreener',priceUsd:'20',eligibleForSensitiveUse:false});
    expect(page.records[0].price).toBeNull();expect(page.summary.reportedTokenizedCapUsd).toBe('40000');
    // DEX token cap is not company cap and must not qualify a top-company ticker row.
    expect(page.records[0].rich?.dex?.change24h).toBe(-2);expect(page.ticker).toEqual([]);
    expect(projectCanonicalMarket({read,query:CanonicalMarketQuerySchema.parse({watchlist:'none'}),nowMs:now,rich}).records).toEqual([]);
    expect(projectCanonicalMarket({read,query:CanonicalMarketQuerySchema.parse({}),nowMs:now+601000,rich}).records[0].displayPrice.priceUsd).toBeNull();
  });
  it('escapes CSV and neutralizes spreadsheet formulas without changing numeric negative returns',()=>{
    expect(csvCell('=HYPERLINK("evil")')).toBe('"\'=HYPERLINK(""evil"")"');expect(csvCell(-2)).toBe('"-2"');expect(csvCell('a,b')).toBe('"a,b"');expect(csvCell(null)).toBe('""');
  });
});
