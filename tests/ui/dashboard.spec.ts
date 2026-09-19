import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { samplePortfolio } from '../../src/services/sample';

async function screenshot(page:Page,name:string){await mkdir('docs/evidence/read-only-phase1/screens',{recursive:true});await page.evaluate(()=>{window.scrollTo(0,0);if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.screenshot({path:`docs/evidence/read-only-phase1/screens/${name}.png`,fullPage:true});}
async function watch(page:Page){await page.getByRole('button',{name:'Live',exact:true}).click();await page.getByText('Read a public address',{exact:true}).click();await page.getByLabel('Solana wallet address').fill('11111111111111111111111111111111');await page.getByRole('button',{name:'Read',exact:true}).click();}
async function labelMock(page:Page){await page.evaluate(()=>{const badge=document.createElement('div');badge.textContent='UI TEST · MOCKED API RESPONSE';badge.style.cssText='position:fixed;bottom:8px;right:8px;background:#233646;color:white;padding:8px 12px;z-index:1000;font:11px Arial;border-radius:4px';document.body.appendChild(badge);});}
async function expectContentBeforeStatus(page:Page,selector:string){expect(await page.locator('#main').evaluate((main,contentSelector)=>{const content=main.querySelector(contentSelector);const status=main.querySelector('.page-data-status');return Boolean(content&&status&&(content.compareDocumentPosition(status)&Node.DOCUMENT_POSITION_FOLLOWING));},selector)).toBe(true);}
test.beforeEach(async({page})=>{const icon='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a6c64"/></svg>';await page.route('https://xstocks-metadata.backed.fi/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));await page.route('https://raw.githubusercontent.com/solana-labs/token-list/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));await page.route('https://static.jup.ag/**',route=>route.fulfill({contentType:'image/svg+xml',body:icon}));});
test('Live is the default, Sample requires a click, and Market analysis stays disabled',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Live',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Sample',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.getByText('Live portfolio · not connected',{exact:true})).toBeVisible();
  await expect(page.getByText('Sample portfolio · simulated values',{exact:true})).toHaveCount(0);
  const marketAnalysis=page.getByRole('button',{name:'Market analysis Soon'});
  await expect(marketAnalysis).toBeDisabled();
  await screenshot(page,'default-live-desktop');
  await page.getByRole('button',{name:'Sample',exact:true}).click();
  await expect(page.getByText('Sample portfolio · simulated values',{exact:true})).toBeVisible();
  await screenshot(page,'sample-selected-desktop');
  await page.reload();
  await expect(page.getByRole('button',{name:'Live',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('Sample portfolio · simulated values',{exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('button',{name:'Live',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await screenshot(page,'default-live-mobile');
});
test('sample overview, exposure, company details, sources and mobile',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();await expect(page.getByText('Sample portfolio · simulated values')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Important stock & ETF holdings'})).toBeVisible();
  await expect(page.getByText('$19,200.00',{exact:true})).toBeVisible();
  await expectContentBeforeStatus(page,'.metrics-grid');
  await expect(page.getByRole('heading',{name:'Data status & coverage'})).toBeVisible();
  await expect(page.locator('.holdings-panel [data-asset-logo="NVIDIA"]').first()).toBeVisible();
  await expect(page.locator('.holdings-panel [data-asset-logo="Tesla"]').first()).toBeVisible();
  await screenshot(page,'sample-overview-desktop');
  await page.getByRole('button',{name:'Technical details'}).click();await expect(page.getByRole('dialog')).toContainText('3000000000000 / 10⁹ USDC');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Explore exposure'}).click();await expect(page.getByRole('heading',{name:'Different tokens. Shared exposure.'})).toBeVisible();
  await expectContentBeforeStatus(page,'.exposure-intro');
  await expect(page.locator('.exposure-table .company-logo .identity-remote').first()).toHaveAttribute('src','https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png');
  await expect(page.locator('.coverage-panel .fund-logo .identity-remote')).toHaveCount(2);
  await screenshot(page,'sample-exposure-desktop');
  await page.getByRole('button',{name:/1 NVIDIA NVDA/}).click();await expect(page.getByRole('dialog')).toContainText('$7,581.83');await expect(page.getByRole('dialog')).toContainText('NVDAx · Earn');await expect(page.getByRole('dialog').locator('.company-logo .identity-remote')).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Sectors',exact:true}).click();await expect(page.getByText('Unknown / unclassified',{exact:true})).toBeVisible();await expect(page.getByText('Financials',{exact:true})).toBeVisible();await expect(page.getByRole('columnheader',{name:'Through ETFs'})).toBeVisible();await screenshot(page,'sample-sectors');
  await page.getByRole('button',{name:'View sources'}).click();await expect(page.getByRole('dialog')).toContainText('99.960481%');await screenshot(page,'sources');await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Overview',exact:true}).click();await screenshot(page,'sample-overview-mobile');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Exposure',exact:true}).click();await screenshot(page,'sample-exposure-mobile');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
});
test('appearance toggle persists and both themes remain readable',async({page})=>{
  await page.emulateMedia({colorScheme:'light'});
  await page.goto('/');await page.getByRole('button',{name:'Sample',exact:true}).click();await expect(page.locator('html')).not.toHaveAttribute('data-theme','dark');
  const light=await page.locator('.holdings-panel').evaluate(element=>{const style=getComputedStyle(element);const row=getComputedStyle(element.querySelector('tbody tr')!);return {border:style.borderColor,background:style.backgroundColor,row:row.backgroundColor,text:row.color};});
  expect(light.border).not.toBe('rgb(255, 255, 255)');expect(light.background).not.toBe(light.row);expect(light.text).toBe('rgb(13, 43, 59)');
  await page.getByRole('button',{name:'Switch to dark mode'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByRole('heading',{name:'Know what you hold.'})).toBeVisible();await screenshot(page,'sample-overview-dark');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.getByRole('button',{name:'Switch to light mode'})).toBeVisible();
  await page.getByRole('button',{name:'Switch to light mode'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await screenshot(page,'sample-overview-light');
});
test('verified securities stay compact on Overview and complete inventory moves to Portfolio',async({page})=>{
  const owner='11111111111111111111111111111111';const fixture=samplePortfolio();fixture.mode='live';fixture.owner=owner;
  const observedAt=new Date().toISOString();const source={...fixture.prices[0].source,id:'ui-security-source',kind:'live' as const,validity:'valid' as const,observedAt,retrievedAt:observedAt};
  fixture.id='ui-security-fixture';fixture.observedAt=observedAt;fixture.holdings=[];fixture.loans=[];fixture.prices=[];fixture.earnPositions=[
    {id:'earn-usdc',owner,receiptMint:'receipt-usdc',assetMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',symbol:'USDC',name:'USD Coin',decimals:6,logoUrl:null,rawUnderlying:'50000',amount:'0.05',apy:'0.0393',referenceValue:null,link:'https://jup.ag/lend/earn?symbol=USDC',source},
    {id:'earn-sol',owner,receiptMint:'receipt-sol',assetMint:'So11111111111111111111111111111111111111112',symbol:'SOL',name:'Wrapped SOL',decimals:9,logoUrl:null,rawUnderlying:'100000',amount:'0.0001',apy:'0.0385',referenceValue:null,link:'https://jup.ag/lend/earn?symbol=SOL',source},
  ];fixture.unmodeledLoans=[];fixture.indexedPositions=[];fixture.issues=[];fixture.capabilities={};fixture.loanRead='ready';
  fixture.walletAssets=[
    {id:'google',owner,mint:'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',symbol:'GOOGLx',name:'Alphabet',tokenProgram:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',decimals:8,accountCount:1,rawAmount:'100000000',unscaledAmount:'1',amount:'1',spendableAmount:'1',verification:'verified',assetClass:'stock',companyId:'ALPHABET',sector:'Communication Services',securityId:'US02079K3059',identitySource:'https://api.xstocks.fi/api/v2/public/assets/GOOGLx',amountConvention:'scaled-ui',referenceValue:{amount:'200',currency:'USD',basis:'reference',source},source},
    {id:'nike',owner,mint:'XsGYpMvKbVt6ViHqRd7cF3s746dAMFBQWcC49hB9VVP',symbol:'NKEx',name:'Nike',tokenProgram:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',decimals:8,accountCount:1,rawAmount:'100000000',unscaledAmount:'1',amount:'1',spendableAmount:'1',verification:'verified',assetClass:'stock',companyId:'NIKE',sector:'Consumer Discretionary',securityId:'US6541061031',identitySource:'https://api.xstocks.fi/api/v2/public/assets/NKEx',amountConvention:'scaled-ui',referenceValue:{amount:'75',currency:'USD',basis:'reference',source},source},
    {id:'spcx',owner,mint:'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb',symbol:'SPCX',name:'SpaceX - Backpack Securities',tokenProgram:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',decimals:8,accountCount:1,rawAmount:'100000000',unscaledAmount:'1',amount:'1',spendableAmount:'1',verification:'verified',assetClass:'stock',companyId:'SPACEX',sector:'Industrials',securityId:'BACKPACK:SPCX',identitySource:'https://learn.backpack.exchange/blog/tokenized-spacex-spcx',amountConvention:'base-decimals',referenceValue:{amount:'150',currency:'USD',basis:'reference',source},source},
    {id:'jup',owner,mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',symbol:'JUP',name:'Jupiter',tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6,accountCount:1,rawAmount:'1000000',unscaledAmount:'1',amount:'1',spendableAmount:'1',verification:'verified',assetClass:'other',companyId:null,sector:null,securityId:null,identitySource:null,logoUrl:'https://static.jup.ag/jup/icon.png',amountConvention:'base-decimals',referenceValue:{amount:'1',currency:'USD',basis:'reference',source},source},
  ];
  await page.route('**/api/portfolio',route=>route.fulfill({json:{status:'ready',data:fixture}}));await page.goto('/');await watch(page);
  const primary=page.locator('.holdings-panel');await expect(primary).toContainText('GOOGLx');await expect(primary).toContainText('NKEx');await expect(primary).toContainText('SPCX');
  await expect(primary.locator('[data-asset-logo="Google"]')).toHaveCount(1);await expect(primary.locator('[data-asset-logo="Nike"]')).toHaveCount(1);await expect(primary.locator('[data-asset-logo="SpaceX"]')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:'Cash and crypto'})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Jupiter Earn'})).toHaveCount(0);
  await page.getByRole('button',{name:'Portfolio',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Cash and crypto'})).toBeVisible();
  await expect(page.locator('#portfolio-cash .identity-remote')).toHaveAttribute('src','https://static.jup.ag/jup/icon.png');
  await expect(page.locator('.earn-card img.identity-remote')).toHaveCount(2);
  await expect(page.locator('.earn-card').filter({hasText:'USDC'}).locator('img.identity-remote')).toHaveAttribute('src',/EPjFWdd5/);
  await expect(page.locator('.earn-card').filter({hasText:'SOL'}).locator('img.identity-remote')).toHaveAttribute('src',/So111111/);
  await labelMock(page);await screenshot(page,'major-stock-logos-mocked');
});
test('unmodeled Jupiter loans retain the official logos for both vault assets',async({page})=>{
  const owner='11111111111111111111111111111111';const fixture=samplePortfolio();const observedAt=new Date().toISOString();
  const source={...fixture.prices[0].source,id:'ui-unmodeled-loan-source',kind:'live' as const,validity:'valid' as const,observedAt,retrievedAt:observedAt};
  fixture.mode='live';fixture.owner=owner;fixture.id='ui-unmodeled-loan-fixture';fixture.observedAt=observedAt;
  fixture.holdings=[];fixture.loans=[];fixture.prices=[];fixture.walletAssets=[];fixture.earnPositions=[];fixture.indexedPositions=[];fixture.issues=[];fixture.capabilities={};
  fixture.unmodeledLoans=[{id:'jupiter-unmodeled:84:326',owner,vaultId:84,positionId:326,
    collateralMint:'Xs7ZdzSHLU9ftNJsii5f2E7kwMGBuV19BRuB8uMNjKo',collateralSymbol:'NVDAx',collateralName:'NVIDIA xStock',collateralLogoUrl:'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png',
    debtMint:'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD',debtSymbol:'JupUSD',debtName:'Jupiter USD',debtLogoUrl:'https://static.jup.ag/jupUSD/icon.png',
    collateralAmount:'0.0002',debtAmount:'0.01',collateralValueUsd:null,debtValueUsd:'0.01',liquidationThreshold:'0.75',
    reason:'Visible through Jupiter; risk and stress calculations require a verified local vault/mint mapping.',link:'https://jup.ag/lend/borrow/84/nfts/326',source}];
  await page.route('**/api/portfolio',route=>route.fulfill({json:{status:'ready',data:fixture}}));await page.goto('/');await watch(page);await page.getByRole('button',{name:'Portfolio',exact:true}).click();
  const row=page.locator('.unmodeled-loan').filter({hasText:'NVDAx / JupUSD'});await expect(row).toBeVisible();
  await expect(row.locator('.paired-icons .identity-remote')).toHaveCount(2);
  await expect(row.locator('.paired-icons .identity-remote').nth(0)).toHaveAttribute('src','https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png');
  await expect(row.locator('.paired-icons .identity-remote').nth(1)).toHaveAttribute('src','https://static.jup.ag/jupUSD/icon.png');
  await labelMock(page);await screenshot(page,'unmodeled-loan-logos-mocked');
});
test('live loading and failed reads are never replaced with samples',async({page})=>{
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/portfolio',async route=>{await held;await route.fulfill({status:502,json:{status:'error',code:'RPC_BLOCKED',message:'Fixture: public RPC request failed (HTTP 429).'}});});
  await page.goto('/');await watch(page);await expect(page.getByRole('status')).toContainText('Reading onchain balances and Jupiter positions');await labelMock(page);await screenshot(page,'live-loading-mocked');release();
  await expect(page.getByRole('heading',{name:'Live data couldn’t be loaded'})).toBeVisible();await expect(page.getByText('$19,200.00',{exact:true})).toHaveCount(0);await screenshot(page,'live-error-mocked');
  await page.getByRole('button',{name:'Sample',exact:true}).click();await expect(page.getByRole('heading',{name:'Important stock & ETF holdings'})).toBeVisible();
});
test('empty and partial live responses have explicit coverage',async({page})=>{
  const fixture=samplePortfolio();fixture.mode='live';fixture.owner='11111111111111111111111111111111';fixture.id='ui-empty-fixture';fixture.holdings=[];fixture.loans=[];fixture.prices=[];fixture.walletAssets=[];fixture.earnPositions=[];fixture.unmodeledLoans=[];fixture.indexedPositions=[];fixture.unsupported=[];fixture.issues=[];fixture.capabilities={};
  await page.route('**/api/portfolio',route=>route.fulfill({json:{status:'empty',data:fixture}}));await page.goto('/');await watch(page);await labelMock(page);
  await expect(page.getByRole('heading',{name:'No balances or positions found'})).toBeVisible();await screenshot(page,'live-empty-mocked');
  fixture.loanRead='blocked';fixture.issues=['Fixture: loan discovery unavailable. Select a position to retry.'];await page.getByRole('button',{name:'Refresh data'}).click();await expect(page.getByRole('heading',{name:'No account data to display yet'})).toBeVisible();await screenshot(page,'live-partial-mocked');
});
test('public-address Live mode and owner survive a full page reload',async({page})=>{
  const owner='11111111111111111111111111111111';let reads=0;
  const fixture=samplePortfolio();fixture.mode='live';fixture.owner=owner;fixture.id='persisted-live-fixture';fixture.observedAt=new Date().toISOString();fixture.holdings=[];fixture.loans=[];fixture.prices=[];fixture.walletAssets=[];fixture.earnPositions=[];fixture.unmodeledLoans=[];fixture.indexedPositions=[];fixture.issues=[];fixture.capabilities={};fixture.loanRead='ready';
  await page.route('**/api/portfolio',route=>{reads++;return route.fulfill({json:{status:'empty',data:fixture}});});
  await page.goto('/');await watch(page);await expect(page.getByText('Live portfolio · public address · read only',{exact:true})).toBeVisible();await expect.poll(()=>reads).toBe(1);
  await page.reload();await expect(page.getByText('Live portfolio · public address · read only',{exact:true})).toBeVisible();await expect(page.getByText('Sample portfolio · simulated values',{exact:true})).toHaveCount(0);await expect.poll(()=>reads).toBe(2);
  await expect(page.getByRole('button',{name:/1111…1111 Disconnect/})).toBeVisible();
});
test('late response cannot repopulate a different mode',async({page})=>{
  let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});await page.route('**/api/portfolio',async route=>{await held;await route.fulfill({status:502,json:{status:'error',code:'OLD',message:'Old wallet response'}});});
  await page.goto('/');await watch(page);await expect(page.getByRole('status')).toBeVisible();await page.getByRole('button',{name:'Sample',exact:true}).click();await expect(page.getByRole('heading',{name:'Important stock & ETF holdings'})).toBeVisible();release();await expect(page.getByText('Old wallet response')).toHaveCount(0);await expect(page.getByText('Sample portfolio · simulated values')).toBeVisible();
});
test('wallet absence, keyboard dialog close, and invalid address response',async({page,request})=>{
  await page.goto('/');await page.getByRole('banner').getByRole('button',{name:'Connect wallet',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('No compatible wallet detected');await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  const response=await request.post('/api/portfolio',{data:{owner:'not-an-address'}});expect(response.status()).toBe(400);
  const unknown=await request.post('/api/portfolio',{data:{owner:'11111111111111111111111111111111',selection:{vaultId:80}}});expect(unknown.status()).toBe(400);
});
test('Wallet Standard connection, account change, cluster change and disconnect (fixture wallet)',async({page})=>{
  await page.addInitScript(()=>{
    type Account={address:string;publicKey:Uint8Array;chains:string[];features:string[]};
    const listeners=new Set<(change:{accounts?:Account[];chains?:string[]})=>void>();
    const first:Account={address:'11111111111111111111111111111111',publicKey:new Uint8Array(32),chains:['solana:mainnet'],features:[]};
    const second:Account={...first,address:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'};
    let accounts:Account[]=[];
    const fixtureWallet={version:'1.0.0',name:'Fixture wallet (test only)',icon:'data:image/svg+xml;base64,PHN2Zy8+',chains:['solana:mainnet'],get accounts(){return accounts;},features:{
      'standard:connect':{version:'1.0.0',connect:async()=>{accounts=[first];return {accounts};}},
      'standard:disconnect':{version:'1.0.0',disconnect:async()=>{accounts=[];listeners.forEach(fn=>fn({accounts}));}},
      'standard:events':{version:'1.0.0',on:(_event:string,fn:(change:{accounts?:Account[];chains?:string[]})=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}},
    }};
    window.addEventListener('wallet-standard:app-ready',event=>(event as CustomEvent<{register:(wallet:unknown)=>void}>).detail.register(fixtureWallet));
    Object.assign(window,{fixtureChangeAccount:()=>{accounts=[second];listeners.forEach(fn=>fn({accounts}));},fixtureChangeChain:()=>listeners.forEach(fn=>fn({chains:['solana:devnet']}))});
  });
  const owners:string[]=[];
  await page.route('**/api/portfolio',route=>{owners.push((route.request().postDataJSON() as {owner:string}).owner);return route.fulfill({status:502,json:{status:'error',code:'TEST',message:'Fixture wallet read failure'}});});
  await page.goto('/');await page.getByRole('banner').getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('button',{name:'Fixture wallet (test only)'}).click();
  await expect(page.getByText('Live portfolio · connected wallet',{exact:true})).toBeVisible();await expect.poll(()=>owners.length).toBe(1);
  await page.reload();await expect(page.getByText('Live portfolio · connected wallet',{exact:true})).toBeVisible();await expect.poll(()=>owners.length).toBe(2);
  await page.evaluate(()=>(window as unknown as {fixtureChangeAccount:()=>void}).fixtureChangeAccount());await expect.poll(()=>owners.length).toBe(3);expect(owners[2]).not.toBe(owners[1]);
  await page.evaluate(()=>(window as unknown as {fixtureChangeChain:()=>void}).fixtureChangeChain());await expect(page.getByRole('heading',{name:'Bring your portfolio into view'})).toBeVisible();
  await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();await page.getByRole('button',{name:'Fixture wallet (test only)'}).click();await expect(page.getByRole('button',{name:/Disconnect/})).toBeVisible();await page.getByRole('button',{name:/Disconnect/}).click();await expect(page.getByRole('heading',{name:'Bring your portfolio into view'})).toBeVisible();
});
