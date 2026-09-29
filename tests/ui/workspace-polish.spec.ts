import { expect, test } from '@playwright/test';

test('workspace motion anchors the brand and ticker continues across pages, pause and themes',async({page,request})=>{
  const base=await(await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const now=new Date().toISOString();
  const item=base.records[0];
  const ticker=Array.from({length:20},(_,i)=>({id:i?`visual-${i}`:item.id,symbol:`TOP${i}x`,name:`Company ${i}`,
    displayPrice:{...item.displayPrice,priceUsd:'123.45',source:'jupiter-price-v3',status:'LIVE',reason:null,observedAt:now,retrievedAt:now},
    change24h:{value:1.2,currency:null,retrievedAt:now}}));
  await page.route('**/api/markets/v2/stocks?**',route=>route.fulfill({json:{...base,source:'current',ticker}}));
  await page.goto('/');
  await expect(page.locator('button.ticker-quote')).toHaveCount(20);
  const strip=page.locator('.stocks-ticker'),track=page.locator('.ticker-track');
  await track.evaluate(el=>{el.setAttribute('data-instance','original');});
  const groupWidths=await page.locator('.ticker-group').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width));
  expect(groupWidths[0]).toBeCloseTo(groupWidths[1],2);
  expect(groupWidths[0]).toBeGreaterThan(1440);
  const at=await track.evaluate(el=>Number(el.getAnimations()[0].currentTime));
  await page.getByRole('button',{name:'Stocks',exact:true}).click();
  await expect(page.locator('.tokenized-table')).toBeVisible();
  await expect(track).toHaveAttribute('data-instance','original');
  expect(await track.evaluate(el=>Number(el.getAnimations()[0].currentTime))).toBeGreaterThan(at);
  const brand=await page.locator('.brand').boundingBox();
  const toggle=await page.locator('.workspace-toggle').boundingBox();
  const top=(await page.locator('main').boundingBox())!.y;
  // Sample the actual animation: width must pass through intermediate values,
  // while the brand, header toggle and main's top edge stay anchored.
  const frames=await page.evaluate(async()=>{
    const button=document.querySelector<HTMLButtonElement>('.workspace-toggle')!;
    button.click();const samples=[];
    for(let i=0;i<22;i++){
      await new Promise(requestAnimationFrame);
      const box=(s:string)=>document.querySelector(s)!.getBoundingClientRect();
      samples.push({rail:box('.sidebar').width,brandX:box('.brand').x,brandY:box('.brand').y,toggleX:box('.workspace-toggle').x,top:box('main').y});
    }return samples;
  });
  expect(frames.some(f=>f.rail>65&&f.rail<223)).toBe(true);
  for(const frame of frames){expect(frame.brandX).toBe(brand!.x);expect(frame.brandY).toBe(brand!.y);expect(Math.abs(frame.toggleX-toggle!.x)).toBeLessThan(1);expect(frame.top).toBe(top);}
  await page.getByRole('button',{name:'Expand workspace sidebar'}).click();
  await expect.poll(()=>page.locator('.sidebar').evaluate(e=>e.getBoundingClientRect().width)).toBe(224);
  await page.getByRole('button',{name:'Pause ticker'}).click();
  const paused=await track.evaluate(el=>({time:Number(el.getAnimations()[0].currentTime),matrix:getComputedStyle(el).transform}));
  await page.waitForTimeout(120);
  expect(await track.evaluate(el=>getComputedStyle(el).transform)).toBe(paused.matrix);
  await page.getByRole('button',{name:'Resume ticker'}).click();
  await page.getByRole('heading',{level:1}).click();
  await page.mouse.move(800,650);
  await expect.poll(()=>track.evaluate(el=>Number(el.getAnimations()[0].currentTime))).toBeGreaterThan(paused.time);
  for(const name of ['Overview','Portfolio','Exposure','Protect']){
    await page.getByRole('button',{name,exact:true}).click();
    await expect(track).toHaveAttribute('data-instance','original');await expect(strip).toBeVisible();
    expect(await page.locator('.brand').boundingBox()).toEqual(brand);
  }
  await page.getByRole('button',{name:'Pause ticker'}).click();
  await page.locator('button.ticker-quote').first().click();
  await expect(page.getByRole('region',{name:'Solana stock market'})).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Switch to dark mode'}).click();
  const dark=await page.locator('.market-panel').evaluate(e=>getComputedStyle(e).borderTopColor);
  await page.getByRole('button',{name:'Switch to light mode'}).click();
  expect(await page.locator('.market-panel').evaluate(e=>getComputedStyle(e).borderTopColor)).not.toBe(dark);
  for(const target of ['.market-panel','.canonical-summary','.workspace-brand']){
    expect(await page.locator(target).evaluate(e=>getComputedStyle(e).borderBottomWidth)).toBe('1px');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await track.evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
  expect(await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).transitionDuration)).toBe('0s');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
