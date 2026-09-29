import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('Tokenized columns persist independently, show sourced fields and session trend; workspace folds without losing brand', async ({ page, request }) => {
  const base = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const row = structuredClone(base.records[0]);
  let version = 0;
  const at = Date.now() - 20_000;
  const field = (value: number) => ({ value, retrievedAt: new Date(at).toISOString(), currency: null });
  row.marketData = { mint: row.variantMints[0], source: 'jupiter-price-v3', referencePrice: field(120), companyCap: null,
    liquidity: { ...field(10000), currency: 'USD' }, change24h: field(2.5), multiplier: field(1.12345),
    circulatingPrescaled: field(1234), totalPrescaled: field(5678) };
  row.listedData = row.marketData;
  row.issuerContext = { issuerIndicativePriceUsd: '121', issuerPriceRetrievedAt: new Date(at).toISOString(),
    issuerPriceSourceUrl: 'https://api.xstocks.fi/api/v2/public/assets/TESTx/price-data', supply: null,
    reserve: { status: 'available', timestamp: null, sharesHeld: '4567', circulatingSupply: null,
      holdings: [{ provider: 'Test custodian', quantity: '4567', symbol: 'TEST' }], retrievedAt: new Date(at).toISOString(),
      sourceUrl: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves/TESTx' } };
  await page.route('https://xstocks-metadata.backed.fi/**', route => route.abort());
  await page.route('**/api/markets/v2/stocks?**', route => route.fulfill({ json: { ...base,
    records: [{ ...row, displayPrice: { ...row.displayPrice, status: 'LIVE', priceUsd: String(123 + version),
      source: 'jupiter-price-v3', reason: null, observedAt: new Date(at + version * 1000).toISOString(), retrievedAt: new Date(at).toISOString() } }],
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } } }));
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  for (const text of ['STOCK MARKET · NO WALLET REQUIRED', 'Exact issuer identities, independently reported prices, and explicit data coverage.', 'Tokenized and Listed share one snapshot. Current market remains available.']) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Current market', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Canonical preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Solana stock market' })).toBeVisible();
  const columns = ['Asset', 'Type', 'Underlying', 'Age', 'Price', '24h %', 'Trend', 'Official', 'xStocks Q.', 'Toked MC', 'FDV', 'Circ Supply', 'Total Supply', 'Shares', 'Mult', 'Solana Mint', 'Market', 'Exchange', 'Liq $', 'Vol 24h', 'Flow', 'Holders'];
  await page.locator('.market-columns summary').click();
  for (const column of columns) await page.getByRole('checkbox', { name: column, exact: true }).check();
  await page.locator('.market-columns summary').click();
  await expect(page.locator('.tokenized-table th')).toHaveText(columns);
  await expect(page.locator('.tokenized-table')).toContainText('Prescaled');
  await expect(page.locator('.tokenized-table')).toContainText('4,567');
  await expect(page.locator('.tokenized-table')).toContainText('1.12345');
  await expect(page.locator('.tokenized-table')).toContainText('$121.00');
  expect((await page.locator('.tokenized-table').boundingBox())!.y).toBeLessThan(650);
  version = 1;
  await page.clock.fastForward(30_000);
  await expect(page.locator('.tokenized-table').getByRole('img', { name: 'Session trend: 2 observed prices' })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.locator('.tokenized-table').getByRole('img', { name: 'Session trend: 2 observed prices' })).toBeVisible();
  const expanded = (await page.locator('.workspace').boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse workspace sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand workspace sidebar' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async()=>(await page.locator('.workspace').boundingBox())!.width).toBeGreaterThan(expanded + 100);
  await expect(page.locator('.brand')).toBeVisible();
  await expect(page.locator('.brand')).toContainText('PositionLayer');
  expect(await page.locator('.brand').evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.right - 20, box.top + box.height / 2));
  })).toBe(true);
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
  await mkdir('docs/evidence/stocks-columns-workspace', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/stocks-columns-workspace/collapsed-desktop.png', fullPage: true, animations: 'disabled' });
  await page.locator('.market-columns summary').click();
  await page.getByRole('checkbox', { name: 'Age', exact: true }).uncheck();
  await page.locator('.market-columns summary').click();
  await page.getByRole('button', { name: 'Listed', exact: true }).click();
  await page.locator('.market-columns summary').click();
  await page.getByRole('checkbox', { name: 'Exchange', exact: true }).uncheck();
  await page.reload();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand workspace sidebar' })).toBeVisible();
  await page.locator('.market-columns summary').click();
  await expect(page.getByRole('checkbox', { name: 'Age', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Exchange', exact: true })).toBeChecked();
  await page.locator('.market-columns summary').click();
  await page.getByRole('button', { name: 'Listed', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Exchange', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand workspace sidebar' }).click();
  await page.getByRole('button', { name: 'Tokenized', exact: true }).click();
  await page.getByRole('button', { name: /Switch to dark mode/ }).click();
  await page.screenshot({ path: 'docs/evidence/stocks-columns-workspace/expanded-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.brand')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'docs/evidence/stocks-columns-workspace/mobile.png', fullPage: true, animations: 'disabled' });
});
