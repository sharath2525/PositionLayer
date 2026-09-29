import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('cap defaults, clean ticker, usable Columns menu and stable brand survive refresh and resizing', async ({page,request}) => {
  const base=await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const now=Date.now();
  const queries: URLSearchParams[]=[];
  let version=0;
  const rows=['NVDA','AAPL','GOOGL','MSFT','AMZN','TSM'].map((symbol,i)=>({...base.records[0],id:`polish-${i}`,symbol,tokenSymbol:`${symbol}x`,
    name:symbol,productClass:'equity',logoUrl:`https://xstocks-metadata.backed.fi/logos/tokens/${symbol}x.png`,
    displayPrice:{...base.records[0].displayPrice,priceUsd:'123',status:'DELAYED',source:'jupiter-price-v3',
      observedAt:new Date(now-60_000).toISOString(),retrievedAt:new Date(now).toISOString(),reason:null}}));
  await page.route('**/api/markets/v2/stocks?**',route=>{
    queries.push(new URL(route.request().url()).searchParams);
    const records=rows.map(r=>({...r,displayPrice:{...r.displayPrice,priceUsd:String(123+version)}}));
    return route.fulfill({json:{...base,source:'current',status:'degraded',records,
      pagination:{page:1,pageSize:20,total:6,totalPages:1},
      ticker:records.map(r=>({id:r.id,symbol:r.tokenSymbol,name:r.name,displayPrice:r.displayPrice,change24h:null}))}});
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button',{name:'Stocks',exact:true}).click();
  await expect(page.locator('.tokenized-table tbody tr')).toHaveCount(6);
  const stockQuery=queries.find(q=>q.get('pageSize')==='20')!;
  expect(stockQuery.get('sort')).toBe('reportedCap');expect(stockQuery.get('direction')).toBe('desc');
  await expect(page.getByRole('button',{name:'Refresh snapshot'})).toHaveCount(0);
  await expect(page.getByText('Partial market coverage.',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Onchain token prices · unpriced identities remain searchable.')).toHaveCount(0);
  const ticker=page.getByRole('complementary',{name:'Top 20 companies by market cap'});
  await expect(ticker).not.toContainText(/delayed|stale/i);
  await expect(ticker.locator('button.ticker-quote').first()).toHaveAttribute('title',/DELAYED/);
  expect((await page.locator('.tokenized-table').boundingBox())!.y).toBeLessThan(480);
  const avatars=page.locator('.tokenized-table .market-avatar');
  await expect(avatars.first().locator('svg')).toHaveAttribute('data-asset-logo','NVIDIA');
  await expect.poll(()=>avatars.nth(1).locator('img').evaluate((e:HTMLImageElement)=>e.naturalWidth)).toBeGreaterThan(0);
  for(const density of ['Compact','Comfortable']){
    await page.getByRole('button',{name:density,exact:true}).click();
    for(const box of await avatars.evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()))) expect(box.width).toBe(box.height);
  }
  const menu=page.locator('.market-columns');
  await menu.locator('summary').click();
  await page.getByRole('checkbox',{name:'Holders',exact:true}).check();
  await expect(page.getByRole('columnheader',{name:'Holders',exact:true})).toHaveCount(1);
  await page.getByRole('checkbox',{name:'Holders',exact:true}).uncheck();
  await expect(page.getByRole('columnheader',{name:'Holders',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(menu).not.toHaveAttribute('open');await expect(menu.locator('summary')).toBeFocused();
  await page.keyboard.press('Enter');await expect(menu).toHaveAttribute('open','');
  await page.getByRole('heading',{level:1}).click();await expect(menu).not.toHaveAttribute('open');
  await menu.locator('summary').click();
  for(const checkbox of await menu.getByRole('checkbox').all()){
    if(await checkbox.isChecked() && await checkbox.evaluate(e=>e.parentElement!.textContent)!=='Asset') await checkbox.uncheck();
  }
  await expect(page.getByRole('checkbox',{name:'Asset',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Reset columns'}).click();
  await expect(page.getByRole('columnheader',{name:'Price',exact:true})).toHaveCount(1);
  await page.keyboard.press('Escape');
  const before=await page.locator('.brand').boundingBox();
  for(let i=0;i<3;i++){
    await page.getByRole('button',{name:'Collapse workspace sidebar'}).click();
    const folded=await page.locator('.brand').boundingBox();
    expect(folded!.width).toBe(before!.width);expect(folded!.height).toBe(before!.height);
    expect((await page.locator('.workspace-toggle').boundingBox())!.x).toBeGreaterThan(folded!.x+folded!.width);
    expect(await page.locator('.brand-mark').evaluate(e=>{const r=e.getBoundingClientRect();return r.width===r.height})).toBe(true);
    await page.getByRole('button',{name:'Expand workspace sidebar'}).click();
  }
  version=1;await page.clock.fastForward(30_000);
  await expect(ticker.locator('button.ticker-quote').first()).toContainText('$124.00');
  await expect(page.locator('.tokenized-table')).toContainText('$124.00');
  await page.getByRole('button',{name:'Listed',exact:true}).click();
  await expect(page.locator('.listed-table tbody tr')).toHaveCount(6);
  expect(queries.at(-1)!.get('sort')).toBe('listedCap');expect(queries.at(-1)!.get('direction')).toBe('desc');
  await page.getByRole('button',{name:'Switch to dark mode'}).click();
  await mkdir('docs/evidence/stocks-polish',{recursive:true});
  await page.screenshot({path:'docs/evidence/stocks-polish/listed-dark.png',animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  await menu.locator('summary').click();
  const panel=await menu.locator('[role=group]').boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.y+panel!.height).toBeLessThanOrEqual(844);
  await page.getByRole('checkbox',{name:'Exchange',exact:true}).uncheck();
  await expect(page.locator('.listed-card-fields').first()).not.toContainText('Exchange');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'docs/evidence/stocks-polish/mobile-dark.png',animations:'disabled'});
});
