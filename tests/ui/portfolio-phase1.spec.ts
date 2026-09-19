import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { samplePortfolio } from '../../src/services/sample';

const owner='11111111111111111111111111111111';
async function shot(page:Page,name:string){await mkdir('docs/evidence/portfolio-phase1/screens',{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`docs/evidence/portfolio-phase1/screens/${name}.png`,fullPage:true});}
async function watch(page:Page){await page.getByRole('button',{name:'Live',exact:true}).click();await page.getByText('Read a public address',{exact:true}).click();await page.getByLabel('Solana wallet address').fill(owner);await page.getByRole('button',{name:'Read',exact:true}).click();}

test.beforeEach(async({page})=>{const icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a6c64"/></svg>';await page.route('https://xstocks-metadata.backed.fi/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));});

test('Overview contains only the approved compact answers and navigation',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();
  await expect(page.getByText('Covered portfolio value')).toBeVisible();
  await expect(page.getByText('Free wallet USDC')).toBeVisible();
  await expect(page.getByText('Outstanding debt')).toBeVisible();
  await expect(page.getByText('Net equity')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Highest-risk supported loan'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Stock & ETF holdings in Earn'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Jupiter Earn'})).toHaveCount(0);
  await expect(page.getByText('Jupiter indexed protocol view')).toHaveCount(0);
  await expect(page.getByText('Unverified and excluded assets')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'View portfolio'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Explore exposure'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Stress this loan'})).toBeVisible();
  await expect(page.locator('.risk-loan-card')).toHaveCount(1);
  await shot(page,'sample-overview-desktop');
});

test('Portfolio groups the complete sample inventory and reconciles stock exposure',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();await page.getByRole('button',{name:'Portfolio',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your whole portfolio.'})).toBeVisible();
  for(const heading of ['Stocks and ETFs','Cash and crypto','Jupiter Earn','Borrow positions','Other indexed protocol positions','Unverified and excluded assets']) await expect(page.getByRole('heading',{name:heading})).toBeVisible();
  await expect(page.getByText('$19,200.00',{exact:true})).toBeVisible();
  await expect(page.getByText('$17,200.00',{exact:true})).toBeVisible();
  await expect(page.getByText('Reconciles with Exposure')).toBeVisible();
  await expect(page.locator('#portfolio-stocks').getByText('Posted collateral',{exact:true})).toBeVisible();
  await expect(page.locator('.earn-card').filter({hasText:'NVDAx'})).toContainText('2.00 NVDAx');
  await expect(page.getByText('No indexed comparison positions')).toBeVisible();
  await expect(page.getByText('No excluded assets')).toBeVisible();
  await shot(page,'sample-portfolio-desktop');
});

test('pasted public address opens Portfolio without signing and remains responsive',async({page})=>{
  const fixture=samplePortfolio();const observedAt=new Date().toISOString();fixture.mode='live';fixture.owner=owner;fixture.id='portfolio-public-address';fixture.observedAt=observedAt;
  for(const holding of fixture.holdings){holding.owner=owner;holding.source={...holding.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};holding.mintState.source={...holding.mintState.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};if(holding.referenceValue)holding.referenceValue.source={...holding.referenceValue.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};}
  for(const loan of fixture.loans){loan.owner=owner;loan.source={...loan.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};if(loan.collateralValue)loan.collateralValue.source=loan.source;if(loan.debtValue)loan.debtValue.source=loan.source;}
  fixture.prices.forEach(price=>{price.source={...price.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};});
  fixture.earnPositions!.forEach(position=>{position.owner=owner;position.source={...position.source,kind:'live',validity:'valid',observedAt,retrievedAt:observedAt};if(position.referenceValue)position.referenceValue.source=position.source;});
  let requestBody:unknown;await page.route('**/api/portfolio',route=>{requestBody=route.request().postDataJSON();return route.fulfill({json:{status:'ready',data:fixture}});});
  await page.setViewportSize({width:390,height:844});await page.goto('/');await watch(page);await page.getByRole('button',{name:'Portfolio',exact:true}).click();
  expect(requestBody).toEqual({owner});
  await expect(page.getByText('Live portfolio · public address · read only',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/sign|submit|execute/i})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,'public-address-portfolio-mobile');
});
