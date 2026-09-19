import { chromium, expect } from '@playwright/test';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

// Actual public-address browser read: no route interception or recorded-response replay.
const probe = JSON.parse(await readFile('docs/evidence/phase2-lend-probe.json','utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width:1440, height:1080 } });
const directory = 'docs/evidence/phase2';
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const startedAt = new Date().toISOString();
try {
  await mkdir(`${directory}/screens`,{recursive:true});
  await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000');
  await page.getByRole('button',{name:'Live',exact:true}).click();
  await page.getByText('Read a public address',{exact:true}).click();
  await page.getByLabel('Solana wallet address').fill(probe.position.owner);
  const responsePromise = page.waitForResponse(r=>r.url().includes('/api/portfolio?'),{timeout:240000});
  await page.getByRole('button',{name:'Read',exact:true}).click();
  await page.screenshot({path:`${directory}/screens/live-loading-real.png`});
  const response = await responsePromise;
  const result = await response.json();
  await writeFile(`${directory}/live-browser-response.json`,JSON.stringify(result,null,2)+'\n');
  if (result.status==='error') {
    await expect(page.getByRole('heading',{name:'Live data couldn’t be loaded'})).toBeVisible();
    await page.screenshot({path:`${directory}/screens/live-error-real.png`,fullPage:true});
  } else {
    await expect(page.getByText('Account observation',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'Protect',exact:true}).click();
    await page.screenshot({path:`${directory}/screens/live-protect-real.png`,fullPage:true});
    await page.locator('.market-context>summary').click();
    await page.screenshot({path:`${directory}/screens/live-market-context-real.png`,fullPage:true});
  }
  const evidence = {startedAt,finishedAt:new Date().toISOString(),method:'Actual browser public-address request; no route mocking',http:response.status(),status:result.status,loans:result.data?.loans.length,holdings:result.data?.holdings.length,issues:result.data?.issues,error:result.message,pageErrors:errors};
  await writeFile(`${directory}/live-browser-check.json`,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
  if(result.status==='error'||errors.length)process.exitCode=1;
} finally { await browser.close(); }
