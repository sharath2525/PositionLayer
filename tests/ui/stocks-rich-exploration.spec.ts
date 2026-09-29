import {test,expect} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
import {stockCsv} from '../../src/domain/stock-export';

test('rich fields, saved watchlist, CSV, history and calculator use the cached source data',async({page,request})=>{
  const base=await(await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const row=structuredClone(base.records[0]),mint=row.displayPrice.mint,at=new Date().toISOString();
  const detail=await(await request.get(`/api/markets/v2/assets/${encodeURIComponent(row.id)}`)).json();
  row.displayPrice={...row.displayPrice,source:'jupiter-price-v3',priceUsd:'20',status:'LIVE',reason:null,observedAt:at,retrievedAt:at};
  row.rich={mint,dex:{retrievedAt:at,sourceUrl:`https://dexscreener.com/solana/${mint}`,pair:mint,priceUsd:20,liquidity:1000,volume24h:2500,change24h:2,marketCap:40000,fdv:80000,buys:60,sells:40,pairCreatedAt:null},
    reserve:{retrievedAt:at,sourceUrl:'https://api.xstocks.fi/api/v2/public/proof-of-reserves/TESTx',observedAt:at,circulating:'2000',shares:'2100',custodians:['Fixture custodian']},
    quote:{retrievedAt:at,sourceUrl:'https://api.xstocks.fi/api/v2/public/assets/TESTx/price-data',priceUsd:21},
    holders:{retrievedAt:at,sourceUrl:`https://api.rugcheck.xyz/v1/tokens/${mint}/report`,count:123,totalSupply:'4000',observedAt:null},
    listed:{retrievedAt:at,sourceUrl:'https://query1.finance.yahoo.com/v8/finance/chart/TEST',symbol:'TEST',currency:'USD',exchange:'NASDAQ',kind:'equity',price:30,observedAt:at,change:3,volume:50000,
      closes:Array.from({length:5},(_,i)=>({at:new Date(Date.now()-(4-i)*86400000).toISOString(),value:26+i}))}};
  row.reportedTokenizedCapUsd='40000';row.reportedVolume24hUsd='2500';
  detail.variants[0].rich=row.rich;detail.variants[0].displayPrice=row.displayPrice;
  const queries:URLSearchParams[]=[],external:string[]=[],errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/api\.jup\.ag|api\.xstocks\.fi|api\.dexscreener|api\.rugcheck|query1\.finance/.test(r.url()))external.push(r.url());});
  await page.route('https://xstocks-metadata.backed.fi/**',r=>r.abort());
  await page.route('**/api/markets/v2/assets/**',r=>r.fulfill({json:detail}));
  await page.route('**/api/markets/v2/stocks-export',r=>{const input=r.request().postDataJSON();return r.fulfill({body:stockCsv([row],input.columns,input.query.view==='listed'),headers:{'Content-Type':'text/csv','X-Export-Rows':'1'}});});
  await page.route('**/api/markets/v2/stocks?**',r=>{const q=new URL(r.request().url()).searchParams;queries.push(q);return r.fulfill({json:{...base,source:'current',status:'ready',enrichmentVersion:'fixture-1',prices:{...base.prices,snapshotId:'fixture-1',completedAt:at},records:[row],pagination:{page:1,pageSize:Number(q.get('pageSize')||20),total:1,totalPages:1}}});});
  await page.goto('/');await page.getByRole('button',{name:'Stocks',exact:true}).click();
  await expect(page.locator('.tokenized-table')).toContainText('$20.00');
  await expect(page.locator('.tokenized-table')).not.toContainText('Jupiter V3');
  await page.getByRole('button',{name:`Add ${row.name} to watchlist`}).first().click();
  await page.getByRole('button',{name:'Watchlist',exact:true}).click();
  await expect.poll(()=>queries.at(-1)?.get('watchlist')).toBe(mint);
  await page.getByRole('button',{name:'Compact',exact:true}).click();
  await expect(page.locator('.canonical-market')).toHaveClass(/stocks-compact/);
  await page.getByLabel('Rows per page').selectOption('50');
  await expect.poll(()=>queries.at(-1)?.get('pageSize')).toBe('50');
  await page.locator('.market-columns summary').click();
  for(const name of ['FDV','Circ Supply','Total Supply','Shares','Flow','Holders'])await page.getByRole('checkbox',{name,exact:true}).check();
  await page.locator('.market-columns summary').click();
  await expect(page.locator('.tokenized-table')).toContainText('60%');
  await expect(page.locator('.tokenized-table')).toContainText('2,100');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();
  const csv=await readFile((await(await downloaded).path())!,'utf8');
  expect(csv).toContain('"Holders"');expect(csv).toContain('"123"');expect(csv).toContain('"DEX retrieved at"');
  await page.getByRole('button',{name:`View ${row.name} variants`}).first().click();
  await expect(page.getByLabel('Estimated value')).toContainText('20.00 USD');
  await page.getByLabel('Calculator quantity').fill('2');await expect(page.getByLabel('Estimated value')).toContainText('40.00 USD');
  await page.getByLabel('Calculator price basis').selectOption('listed');await expect(page.getByLabel('Estimated value')).toContainText('60.00 USD');
  await page.getByLabel('Calculator quantity').fill('-1');await expect(page.getByLabel('Estimated value')).toContainText('valid quantity');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Listed',exact:true}).click();
  await expect(page.locator('.listed-table')).toContainText('$30.00');
  await expect(page.locator('.listed-table').getByRole('img',{name:'Five-day history: 5 observed prices'})).toBeVisible();
  await mkdir('docs/evidence/stocks-phase2',{recursive:true});await page.screenshot({path:'docs/evidence/stocks-phase2/listed-fixture.png',fullPage:true});
  await page.reload();await page.getByRole('button',{name:'Stocks',exact:true}).click();
  await expect(page.getByRole('button',{name:`Remove ${row.name} from watchlist`}).first()).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.canonical-market')).toHaveClass(/stocks-compact/);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({path:'docs/evidence/stocks-phase2/mobile-fixture.png',fullPage:true});
  expect(external).toEqual([]);expect(errors).toEqual([]);
});

test('CSV endpoint captures all filtered rows in one read and rejects invalid columns',async({request})=>{
  const page=await(await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const response=await request.post('/api/markets/v2/stocks-export',{data:{query:{},columns:['Asset','Price','Solana Mint']}});
  expect(response.status()).toBe(200);expect(Number(response.headers()['x-export-rows'])).toBe(page.pagination.total);
  expect((await response.text()).split('\r\n')).toHaveLength(page.pagination.total+1);
  const filtered=await request.post('/api/markets/v2/stocks-export',{data:{query:{search:page.records[0].variantMints[0]},columns:['Asset']}});
  expect(filtered.headers()['x-export-rows']).toBe('1');
  expect((await request.post('/api/markets/v2/stocks-export',{data:{query:{},columns:['malicious']}})).status()).toBe(400);
  expect((await request.post('/api/markets/v2/stocks-export',{data:{query:{pageSize:99999},columns:['Asset']}})).status()).toBe(400);
});
