import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { workedExamplePortfolio } from '../../src/services/worked-example';
import { asLive } from '../fixtures/phase2';
import type { Portfolio } from '../../src/domain/types';

const owner='11111111111111111111111111111111';
async function shot(page:Page,name:string){await mkdir('docs/evidence/read-only-phase1/screens',{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`docs/evidence/read-only-phase1/screens/${name}.png`,fullPage:true});}
async function watch(page:Page){await page.getByRole('button',{name:'Live',exact:true}).click();await page.getByText('Read a public address',{exact:true}).click();await page.getByLabel('Solana wallet address').fill(owner);await page.getByRole('button',{name:'Read',exact:true}).click();}
function liveFixture(stale=false, ageMs=stale?10*60*1000:0):Portfolio {
  const observedAt=new Date(Date.now()-ageMs).toISOString();
  const portfolio=asLive(workedExamplePortfolio());portfolio.owner=owner;portfolio.id='read-only-ui-live';portfolio.observedAt=observedAt;
  const at=portfolio.observedAt;
  portfolio.holdings.forEach(row=>{row.owner=owner;row.source.observedAt=at;row.source.validity=stale?'stale':'valid';row.mintState.source.observedAt=at;row.mintState.source.validity=stale?'stale':'valid';if(row.referenceValue){row.referenceValue.source.observedAt=at;row.referenceValue.source.validity=stale?'stale':'valid';}});
  portfolio.loans.forEach(row=>{row.owner=owner;row.source.observedAt=at;row.source.validity=stale?'stale':'valid';if(row.collateralValue){row.collateralValue.source.observedAt=at;row.collateralValue.source.validity=stale?'stale':'valid';}if(row.debtValue){row.debtValue.source.observedAt=at;row.debtValue.source.validity=stale?'stale':'valid';}});
  portfolio.earnPositions?.forEach(row=>{row.owner=owner;row.source.observedAt=at;row.source.retrievedAt=at;row.source.validity=stale?'stale':'valid';if(row.referenceValue){row.referenceValue.source.observedAt=at;row.referenceValue.source.retrievedAt=at;row.referenceValue.source.validity=stale?'stale':'valid';}});
  portfolio.prices.forEach(row=>{row.source.observedAt=at;row.source.validity=stale?'stale':'valid';});
  return portfolio;
}

test.beforeEach(async({page})=>{const icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a6c64"/></svg>';await page.route('https://xstocks-metadata.backed.fi/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));await page.route('https://raw.githubusercontent.com/solana-labs/token-list/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));});

test('sample risk meter leads to a complete read-only protection plan',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();
  const loan=page.locator('.risk-loan-card');
  await expect(loan).toContainText('Within borrow range');
  await expect(loan).toContainText('Borrow 65.00%');
  await expect(loan).toContainText('Liquidation 75.00%');
  await expect(loan.locator('.risk-layout')).toBeVisible();
  await expect(loan.locator('.risk-metric-card')).toHaveCount(3);
  await expect(loan.locator('.risk-position-marker.current')).toHaveAttribute('data-position','60.0000');
  await expect(loan.locator('.risk-threshold-marker.borrow')).toHaveAttribute('data-position','65.0000');
  await expect(loan.locator('.risk-threshold-marker.liquidation')).toHaveAttribute('data-position','75.0000');
  await expect(loan.locator('.paired-icons img.identity-remote')).toHaveCount(2);
  const gaugeGeometry=await loan.locator('.risk-dial').evaluate(element=>{const dial=element.getBoundingClientRect();const icon=element.querySelector('.risk-dial-center svg')!.getBoundingClientRect();return {dialWidth:dial.width,iconWidth:icon.width,iconHeight:icon.height};});
  expect(gaugeGeometry.dialWidth).toBeLessThanOrEqual(360);expect(gaugeGeometry.iconWidth).toBeLessThanOrEqual(18);expect(gaugeGeometry.iconHeight).toBeLessThanOrEqual(18);
  await expect(loan.getByRole('img')).toHaveAttribute('aria-label',/Current LTV 60.00%/);
  await loan.getByRole('button',{name:'Stress this loan'}).click();
  await expect(page.getByText('CURRENT + STRESSED RISK')).toBeVisible();
  await expect(page.getByText(/HYPOTHETICAL stressed marker/)).toBeVisible();
  await expect(page.getByText('Protection plan only.')).toBeVisible();
  await expect(page.getByText(/No transaction was created, no wallet signature was requested, and no balance changed/)).toBeVisible();
  await expect(page.getByRole('button',{name:/sign|submit|execute/i})).toHaveCount(0);
  await page.getByRole('button',{name:'Use worked example'}).click();
  await expect(page.getByTestId('repayment-estimate')).toHaveText('1,825.00 USDC');
  await expect(page.getByRole('img')).toHaveAttribute('aria-label',/Hypothetical stressed LTV 76\.47%/);
  await page.getByRole('radio',{name:/Current protocol valuation/}).check();
  await expect(page.getByTestId('repayment-estimate')).toHaveText('1,000.00 USDC');
  await shot(page,'sample-protection');
});

test('public-address mode posts privately and returns no transaction material',async({page})=>{
  const fixture=liveFixture();let method='';let url='';let body:unknown;
  await page.route('**/api/portfolio',route=>{method=route.request().method();url=route.request().url();body=route.request().postDataJSON();return route.fulfill({json:{status:'ready',data:fixture}});});
  await page.goto('/');await watch(page);
  await expect(page.getByText('Live portfolio · public address · read only',{exact:true})).toBeVisible();
  expect(method).toBe('POST');expect(url).not.toContain(owner);expect(body).toEqual({owner});
  const serialized=JSON.stringify(fixture);expect(serialized).not.toMatch(/unsignedTransaction|signedTransaction|messageBase64|transactionBytes/);
  await expect(page.locator('.risk-loan-card')).toContainText('Above maximum-borrow LTV');
  await page.locator('.risk-loan-card').getByRole('button',{name:'Stress this loan'}).click();
  await expect(page.getByText('Protection plan only.')).toBeVisible();
  await shot(page,'public-address-protection');
});

test('stale live inputs fail closed as Risk unavailable',async({page})=>{
  await page.route('**/api/portfolio',route=>route.fulfill({json:{status:'stale',data:liveFixture(true)}}));
  await page.goto('/');await watch(page);
  await expect(page.locator('.risk-loan-card')).toContainText('Risk unavailable');
  await expect(page.locator('.risk-loan-card')).toContainText(/stale, future-dated, or unverified/);
  await shot(page,'stale-risk-unavailable');
});

test('visible live risk views refresh before the meter reaches its stale boundary',async({page})=>{
  let reads=0;
  await page.route('**/api/portfolio',route=>{
    reads++;
    const fixture=reads===1?liveFixture(false,91_000):liveFixture();
    return route.fulfill({json:{status:'ready',data:fixture}});
  });
  await page.goto('/');await watch(page);
  await expect.poll(()=>reads).toBe(2);
  await expect(page.locator('.risk-loan-card')).not.toContainText('Risk unavailable');
  await expect(page.locator('.risk-loan-card')).toContainText(/Observed [0-9]s ago/);
});

test('wallet connection reads only the public address and never invokes signing',async({page})=>{
  await page.addInitScript(()=>{
    type Account={address:string;publicKey:Uint8Array;chains:string[];features:string[]};
    const account:Account={address:'11111111111111111111111111111111',publicKey:new Uint8Array(32),chains:['solana:mainnet'],features:['solana:signTransaction','solana:signMessage']};
    const listeners=new Set<(change:{accounts?:Account[]})=>void>();let accounts:Account[]=[];let signatures=0;
    const wallet={version:'1.0.0',name:'Read-only fixture wallet',icon:'data:image/svg+xml;base64,PHN2Zy8+',chains:['solana:mainnet'],get accounts(){return accounts;},features:{
      'standard:connect':{version:'1.0.0',connect:async()=>{accounts=[account];return {accounts};}},
      'standard:disconnect':{version:'1.0.0',disconnect:async()=>{accounts=[];listeners.forEach(fn=>fn({accounts}));}},
      'standard:events':{version:'1.0.0',on:(_event:string,fn:(change:{accounts?:Account[]})=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}},
      'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:[0],signTransaction:async()=>{signatures++;throw Error('Signing must not be called');}},
      'solana:signMessage':{version:'1.0.0',signMessage:async()=>{signatures++;throw Error('Signing must not be called');}},
    }};
    window.addEventListener('wallet-standard:app-ready',event=>(event as CustomEvent<{register:(value:unknown)=>void}>).detail.register(wallet));
    Object.assign(window,{readOnlySignatureCalls:()=>signatures});
  });
  await page.route('**/api/portfolio',route=>route.fulfill({json:{status:'ready',data:liveFixture()}}));
  await page.goto('/');await page.getByRole('banner').getByRole('button',{name:'Connect wallet',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('public Solana address only');
  await page.getByRole('button',{name:'Read-only fixture wallet'}).click();
  await expect(page.getByText('Live portfolio · connected wallet',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {readOnlySignatureCalls:()=>number}).readOnlySignatureCalls())).toBe(0);
  await expect(page.getByRole('button',{name:/sign|submit|execute/i})).toHaveCount(0);
});

test('risk and protection remain usable at mobile width',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();
  await expect(page.locator('.risk-loan-card')).toContainText('Within borrow range');
  expect(await page.locator('.risk-layout').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.locator('.risk-dial').evaluate(element=>element.getBoundingClientRect().width)).toBeLessThanOrEqual(300);
  await page.locator('.risk-loan-card').getByRole('button',{name:'Stress this loan'}).click();
  await expect(page.getByText('Protection plan only.')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,'sample-mobile');
});
