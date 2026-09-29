import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('Phase 1 Tokenized / Listed views preserve independent fields, snapshot refresh and mobile layout', async ({ page, request }) => {
  const baseline = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const row = structuredClone(baseline.records[0]);
  const now = new Date().toISOString();
  const field = (value: number, currency: string | null = null) => ({ value, currency, retrievedAt: now });
  const data = { mint: row.variantMints[0], source: 'jupiter-price-v3', referencePrice: field(123.45),
    companyCap: field(12345000), liquidity: field(42000, 'USD'), change24h: field(-2.5),
    multiplier: field(1.2), circulatingPrescaled: field(1000), totalPrescaled: field(2000) };
  row.marketData = data; row.listedData = data; row.listingCountry = 'GB';
  row.displayPrice = { ...row.displayPrice, status: 'UNAVAILABLE', priceUsd: null, source: null,
    observedAt: null, retrievedAt: null, reason: 'no-token-observation' };
  row.price = null;
  const result = { ...baseline, summary: { ...baseline.summary, referencePriceCount: 1, providerCompanyCapCount: 1 },
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, records: [row] };
  const detail = await (await request.get(`/api/markets/v2/assets/${encodeURIComponent(row.id)}`)).json();
  detail.variants[0].marketData = data;
  let reads = 0;
  const views: string[] = [];
  await page.route('**/api/markets/v2/stocks?**', route => {
    reads++; views.push(new URL(route.request().url()).searchParams.get('view') ?? '');
    return route.fulfill({ json: result });
  });
  await page.route('**/api/markets/v2/assets/**', route => route.fulfill({ json: detail }));
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Tokenized', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: 'Price', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Listed', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Price', exact: true })).toBeVisible();
  await expect(page.locator('.listed-table [title*="currency unverified"]').getByText('123.45',{exact:true}).first()).toBeVisible();
  expect(views).toContain('listed');
  const previous = reads;
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(page.getByRole('button', { name: 'Refresh snapshot', exact: true })).toHaveCount(0);
  await mkdir('docs/evidence/stocks-upgrade-phase1', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/stocks-upgrade-phase1/listed-desktop.png', fullPage: true });
  await page.getByRole('button', { name: `View ${row.name} variants` }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Prescaled circulating / total supply')).toBeVisible();
  await expect(drawer.getByText('Provider multiplier', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Cached Meteora evidence')).toBeVisible();
  await expect(drawer.getByText('Cached Lend availability')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.canonical-market .market-cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'docs/evidence/stocks-upgrade-phase1/listed-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Tokenized', exact: true }).click();
  await expect(page.locator('.market-card-price [title*="no-token-observation"]')).toBeVisible();
});
