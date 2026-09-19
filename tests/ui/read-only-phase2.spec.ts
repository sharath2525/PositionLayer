import { test,expect,type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { byId } from '../../src/config/instruments';

const disclosure='The requested stock-to-USDC pair and exact size are disclosed to Jupiter for this quote check.';
async function shot(page:Page,name:string){
  await mkdir('docs/evidence/read-only-phase2/screens',{recursive:true});
  await page.screenshot({path:`docs/evidence/read-only-phase2/screens/${name}.png`,fullPage:true});
}
async function openLiquidityExample(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'Sample',exact:true}).click();
  await page.getByRole('button',{name:'Protect',exact:true}).click();
  await page.getByRole('button',{name:'Use worked example'}).click();
  await expect(page.getByTestId('repayment-estimate')).toHaveText('1,825.00 USDC');
  await expect(page.locator('.funding-summary .negative')).toHaveText('1,325.00 USDC');
}

test.beforeEach(async({page})=>{const icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a6c64"/></svg>';await page.route('https://xstocks-metadata.backed.fi/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));await page.route('https://raw.githubusercontent.com/solana-labs/token-list/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));});

test('quote evidence is user-triggered, narrow, non-transactional, and invalidated by plan changes',async({page})=>{
  let quoteRequests=0;let executeRequests=0;let requestBody:Record<string,unknown>|null=null;
  await page.route('**/execute**',route=>{executeRequests++;return route.abort();});
  await page.route('**/api/protection-liquidity',route=>{
    quoteRequests++;requestBody=route.request().postDataJSON() as Record<string,unknown>;
    const observedAt=new Date().toISOString();const expiresAt=new Date(Date.now()+30_000).toISOString();
    return route.fulfill({json:{schemaVersion:1,state:'potentially-covered',mode:'sample',snapshotId:requestBody.snapshotId,planKey:requestBody.planKey,loanId:requestBody.loanId,
      inputInstrumentId:'NVDAx',inputMint:byId.NVDAx.mint,outputMint:byId.USDC.mint,tokenProgram:byId.NVDAx.tokenProgram,decimals:8,multiplier:'1',
      freeInputBaseUnits:'1400000000',freeInputDisplay:'14',inputBaseUnits:'1060000000',inputDisplay:'10.6',shortfallBaseUnits:'1325000000',shortfallUsdc:'1325',
      expectedOutputBaseUnits:'1325000000',expectedOutputUsdc:'1325',coverageRatio:'1',remainingShortfallUsdc:'0',currentCashUsdc:'500',currentCashAfterQuoteUsdc:'500',
      router:'metis',observedAt,expiresAt,providerExpiryAt:null,sourceId:'jupiter-swap-v2-order-quote-only',quoteAttemptCount:1,transactionCreated:false,warnings:['Fixture quote only.'],blockers:[],disclosure}});
  });
  await openLiquidityExample(page);
  expect(quoteRequests).toBe(0);await expect(page.getByText('Quote only.')).toBeVisible();
  await page.getByRole('button',{name:'Check Jupiter liquidity'}).click();
  await expect(page.getByText('Potentially covered',{exact:true})).toBeVisible();
  await expect(page.getByText('Exact stock input quoted',{exact:true}).locator('xpath=following-sibling::dd[1]')).toContainText('10.600000 NVDAx');
  await expect(page.getByText('Expected Jupiter output',{exact:true}).locator('xpath=following-sibling::dd[1]')).toContainText('1,325.00 USDC');
  expect(quoteRequests).toBe(1);expect(executeRequests).toBe(0);
  expect(Object.keys(requestBody!).sort()).toEqual(['instrumentId','loanId','mode','owner','planKey','scenario','snapshotId','target','targetBasis'].sort());
  expect(JSON.stringify(requestBody)).not.toMatch(/taker|payer|outputMint|transaction|signature|execute/i);
  await expect(page.getByText('No transaction was created, no signature was requested, and output is not guaranteed execution.')).toBeVisible();
  await shot(page,'sample-quote-potentially-covered');
  await page.getByLabel('Target LTV (%)').fill('54');
  await expect(page.getByText('Potentially covered',{exact:true})).toHaveCount(0);
  await expect(page.getByTestId('repayment-estimate')).not.toHaveText('1,825.00 USDC');
});

test('quote service failure is isolated and the Phase 1 plan remains usable',async({page})=>{
  await page.route('**/api/protection-liquidity',route=>route.fulfill({status:429,json:{error:'Quote checks are rate-limited. Wait a few seconds and try again.',code:'RATE_LIMITED'}}));
  await openLiquidityExample(page);await page.getByRole('button',{name:'Check Jupiter liquidity'}).click();
  await expect(page.locator('.liquidity-check .planning-errors')).toContainText('Quote checks are rate-limited');
  await expect(page.getByTestId('repayment-estimate')).toHaveText('1,825.00 USDC');
  await expect(page.getByText('Protection plan only.')).toBeVisible();
  await shot(page,'sample-quote-rate-limited');
});

test('no-route and expired quote states remain explicit dated evidence',async({page})=>{
  let attempt=0;
  await page.route('**/api/protection-liquidity',route=>{
    attempt++;const body=route.request().postDataJSON() as Record<string,unknown>;const observedAt=new Date().toISOString();
    const common={schemaVersion:1,mode:'sample',snapshotId:body.snapshotId,planKey:body.planKey,loanId:body.loanId,inputInstrumentId:'NVDAx',inputMint:byId.NVDAx.mint,
      outputMint:byId.USDC.mint,tokenProgram:byId.NVDAx.tokenProgram,decimals:8,multiplier:'1',freeInputBaseUnits:'1400000000',freeInputDisplay:'14',
      inputBaseUnits:'1400000000',inputDisplay:'14',shortfallBaseUnits:'1325000000',shortfallUsdc:'1325',remainingShortfallUsdc:'1325',currentCashUsdc:'500',currentCashAfterQuoteUsdc:'500',
      observedAt,providerExpiryAt:null,quoteAttemptCount:1,transactionCreated:false,blockers:[],disclosure};
    return route.fulfill({json:attempt===1?{...common,state:'no-route',expectedOutputBaseUnits:null,expectedOutputUsdc:null,coverageRatio:null,router:null,
      expiresAt:new Date(Date.now()+30_000).toISOString(),sourceId:null,warnings:['No usable route for this exact pair and size.']}
      :{...common,state:'expired',expectedOutputBaseUnits:'1325000000',expectedOutputUsdc:'1325',coverageRatio:'1',remainingShortfallUsdc:'0',router:'metis',
        expiresAt:new Date(Date.now()-1).toISOString(),sourceId:'jupiter-swap-v2-order-quote-only',warnings:['This quote observation expired.']}});
  });
  await openLiquidityExample(page);await page.getByRole('button',{name:'Check Jupiter liquidity'}).click();
  await expect(page.getByText('No route',{exact:true})).toBeVisible();await expect(page.getByText(/No usable Jupiter route/)).toBeVisible();
  await shot(page,'sample-quote-no-route');
  await page.getByRole('button',{name:'Check Jupiter liquidity'}).click();
  await expect(page.getByText('Expired',{exact:true})).toBeVisible();await expect(page.getByText(/retained as dated evidence/)).toBeVisible();
  await shot(page,'sample-quote-expired');
});

test('quote-only protection panel remains readable at mobile width',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await openLiquidityExample(page);
  await expect(page.getByRole('button',{name:'Check Jupiter liquidity'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,'sample-quote-mobile');
});
