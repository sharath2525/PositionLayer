import { chromium } from '@playwright/test';

const baseUrl=process.env.PROBE_BASE_URL??'http://127.0.0.1:3000';
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1080}});
page.setDefaultTimeout(180_000);
try{
  await page.goto(baseUrl);
  await page.getByRole('button',{name:'Protect',exact:true}).click();
  await page.getByRole('button',{name:'Use worked example'}).click();
  const responsePromise=page.waitForResponse(response=>response.url().includes('/api/protection-liquidity'),{timeout:180_000});
  await page.getByRole('button',{name:'Check Jupiter liquidity'}).click();
  const response=await responsePromise;const body=await response.json();
  if(body.transactionCreated!==false)throw Error('Quote-only invariant failed.');
  console.log(JSON.stringify({
    probe:'public Jupiter Swap V2 order quote-only',finishedAt:new Date().toISOString(),http:response.status(),
    requestBoundary:{browserEndpoint:'/api/protection-liquidity',providerMethod:'GET',providerPath:'/swap/v2/order',providerQueryKeys:['inputMint','outputMint','amount'],takerOmitted:true},
    evidence:body,
  },null,2));
}finally{await browser.close();}
