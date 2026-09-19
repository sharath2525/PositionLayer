import { chromium } from '@playwright/test';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const probe = JSON.parse(await readFile('docs/evidence/lend-probe.json','utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width:1440, height:1080 } });
try {
  await page.goto('http://127.0.0.1:3000');
  await page.getByRole('button',{name:'Live',exact:true}).click();
  await page.getByText('Read a public address',{exact:true}).click();
  await page.getByLabel('Solana wallet address').fill(probe.position.owner);
  const responsePromise = page.waitForResponse(r=>r.url().includes('/api/portfolio?'),{timeout:180000});
  await page.getByRole('button',{name:'Read',exact:true}).click();
  await mkdir('docs/evidence/screens',{recursive:true});
  await page.screenshot({path:'docs/evidence/screens/live-loading-real.png',fullPage:true});
  const response = await responsePromise;
  const result = await response.json();
  await writeFile('docs/evidence/live-browser-response.json',JSON.stringify(result,null,2)+'\n');
  if (result.status!=='error') await page.getByText('Account observation',{exact:false}).waitFor();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'docs/evidence/screens/live-overview-real.png',fullPage:true});
  await page.getByRole('button',{name:'Exposure',exact:true}).click();
  await page.screenshot({path:'docs/evidence/screens/live-exposure-real.png',fullPage:true});
  console.log(JSON.stringify({status:result.status,http:response.status(),loans:result.data?.loans.length,holdings:result.data?.holdings.length,issues:result.data?.issues,message:result.message}));
} finally { await browser.close(); }
