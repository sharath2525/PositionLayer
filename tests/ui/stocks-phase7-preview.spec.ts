import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function openPreview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await page.getByRole('button', { name: 'Canonical preview' }).click();
  await expect(page.getByRole('region', { name: 'Canonical Solana stock catalog preview' })).toBeVisible();
}

test('canonical preview is wallet-independent, server-paged, keyboard accessible, and responsive', async ({ page, request }) => {
  const api = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  expect(api.records.length).toBeGreaterThan(0);
  const external: string[] = [];
  page.on('request', current => {
    if (/api\.jup\.ag|api\.xstocks\.fi|solana\.com/.test(current.url())) external.push(current.url());
  });
  await page.route('**/api/markets/stocks**', route => route.fulfill({ status: 503 }));
  await openPreview(page);
  await expect(page.getByText('Searchable identities')).toBeVisible();
  await expect(page.getByText('Token prices shown')).toBeVisible();
  await page.getByText('Full catalog and provider coverage').click();
  await expect(page.getByText('Price targets / attempted / returned')).toBeVisible();
  await expect(page.getByText('Company cap available / unavailable / N/A')).toBeVisible();
  await expect(page.getByText('Covered Solana tokenized cap')).toBeVisible();
  await expect(page.getByText('Price writer is not connected or has not started.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(1);
  expect(external).toEqual([]);
  await mkdir('docs/evidence/market-phase7', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/market-phase7/canonical-desktop.png', fullPage: true });

  await page.getByRole('combobox', { name: 'Canonical price availability' }).selectOption('available');
  await expect(page.getByText('No identities match these filters')).toBeVisible();
  await expect(page.getByText(`${api.summary.canonicalCount} identities remain in the catalog.`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  const first = api.records[0];
  await page.getByPlaceholder('Search name, ticker, ISIN, or exact mint').fill(first.variantMints[0]);
  await expect(page.getByText('1–1 of 1')).toBeVisible();
  await page.getByRole('button', { name: `View ${first.name} variants` }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(first.variantMints[0], { exact: true })).toBeVisible();
  await expect(dialog.getByText('Issuer reference')).toBeVisible();
  await expect(dialog.getByText('Derived Solana cap')).toBeVisible();
  await expect(dialog.getByText('Jupiter Lend')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: `View ${first.name} variants` }).first()).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.canonical-market .market-cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'docs/evidence/market-phase7/canonical-mobile.png', fullPage: true });
});

test('provider degradation, missing logo, company-cap distinction, and recovery stay explicit', async ({ page, request }) => {
  const base = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const first = structuredClone(base.records[0]);
  first.productClass = 'etf';
  first.companyCap = { status: 'not-applicable', valueUsd: null, reason: 'etf' };
  first.logoUrl = 'https://xstocks-metadata.backed.fi/logos/tokens/MISSING.png';
  first.price = null;
  first.priceUnavailableReason = 'stale-price';
  first.displayPrice = { ...first.displayPrice, status: 'UNAVAILABLE', priceUsd: null,
    observedAt: null, retrievedAt: null, source: null, reason: 'stale-price' };
  const degraded = { ...base, source: 'current', status: 'degraded',
    catalog: { ...base.catalog, status: 'degraded' },
    providers: { ...base.providers, xstocks: 'unavailable', jupiterPrice: 'unavailable' },
    prices: { ...base.prices, failedBatchCount: 2, incomplete: true },
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, records: [first] };
  const recovered = { ...degraded, status: 'ready', catalog: { ...degraded.catalog, status: 'complete' },
    providers: { ...degraded.providers, xstocks: 'ready', jupiterPrice: 'ready' },
    prices: { ...degraded.prices, failedBatchCount: 0, incomplete: false } };
  let failed = true;
  const detail = await (await request.get(`/api/markets/v2/assets/${encodeURIComponent(first.id)}`)).json();
  const observedAt = new Date(Date.now() - 121_000).toISOString();
  detail.variants[0].tokenPrice = { status: 'blocked', mint: first.variantMints[0], reason: 'stale-price' };
  detail.variants[0].lastAttempt = 'failed';
  detail.variants[0].retainedLastGood = true;
  detail.variants[0].lastObservation = { priceUsd: '42', unit: `token-unit:token:${first.variantMints[0]}`,
    observedAt, retrievedAt: observedAt };
  detail.selectedPrice = { ...detail.selectedPrice, status: 'unavailable', selected: null,
    reason: 'stale-price' };
  await page.route('**/api/markets/stocks**', route => route.fulfill({ status: 503 }));
  await page.route('**/api/markets/v2/stocks?**', route => route.fulfill({ json: failed ? degraded : recovered }));
  await page.route('**/api/markets/v2/assets/**', route => route.fulfill({ json: detail }));
  await page.route('https://xstocks-metadata.backed.fi/logos/tokens/MISSING.png', route => route.abort());
  await openPreview(page);
  await expect(page.getByText('Partial market coverage.')).toBeVisible();
  await expect(page.getByText('Unavailable · stale-price')).toBeVisible();
  await expect(page.getByText('N/A · ETF').first()).toBeVisible();
  await expect(page.locator('.canonical-market .market-avatar[data-logo-state="initials-fallback"]').first()).toBeVisible();
  await page.getByRole('button', { name: `View ${first.name} variants` }).first().click();
  await expect(page.getByRole('dialog').getByText(/display context only/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Derived Solana cap')).toBeVisible();
  await page.keyboard.press('Escape');
  failed = false;
  await page.getByRole('combobox', { name: 'Canonical asset type' }).selectOption('etf');
  await expect(page.getByText('Partial market coverage.')).not.toBeVisible();
  await expect(page.getByText('N/A · ETF').first()).toBeVisible();
});

test('canonical preview remains independent of Sample and failed Live portfolio reads', async ({ page }) => {
  await page.route('**/api/markets/stocks**', route => route.fulfill({ status: 503 }));
  await page.route('**/api/portfolio', route => route.fulfill({ status: 503, json: { status: 'error', code: 'REQUEST_FAILED', message: 'fixture outage' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await page.getByRole('button', { name: 'Canonical preview' }).click();
  await expect(page.getByText('Searchable identities')).toBeVisible();
  await page.getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByText('Read a public address', { exact: true }).click();
  await page.getByLabel('Solana wallet address').fill('11111111111111111111111111111111');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByText('Searchable identities')).toBeVisible();
  await page.getByRole('button', { name: 'Current market' }).click();
  await expect(page.getByText('300 issuer-confirmed Solana assets')).toBeVisible();
});

test('each optional source outage, total fallback, and recovery remain field-specific snapshot reads', async ({ page, request }) => {
  const base = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  let source = 'issuer';
  await page.route('**/api/markets/stocks**', route => route.fulfill({ status: 503 }));
  await page.route('**/api/markets/v2/stocks?**', route => {
    const statuses = source === 'issuer' ? { xstocks: 'unavailable', jupiterTag: 'ready', jupiterPrice: 'ready' }
      : source === 'discovery' ? { xstocks: 'ready', jupiterTag: 'unavailable', jupiterPrice: 'ready' }
        : source === 'price' ? { xstocks: 'ready', jupiterTag: 'ready', jupiterPrice: 'unavailable' }
          : source === 'total' ? { xstocks: 'unavailable', jupiterTag: 'unavailable', jupiterPrice: 'unavailable' }
            : { xstocks: 'ready', jupiterTag: 'ready', jupiterPrice: 'ready' };
    const fallback = source === 'total';
    return route.fulfill({ json: { ...base, source: fallback ? 'bundled' : 'current',
      status: source === 'recovered' ? 'ready' : 'degraded',
      catalog: { ...base.catalog, status: source === 'recovered' ? 'complete' : 'degraded' },
      prices: { ...base.prices, cycleState: fallback ? 'failed' : base.prices.cycleState },
      providers: { ...base.providers, ...statuses } } });
  });
  await openPreview(page);
  await expect(page.getByText(/issuer registry: unavailable/)).toBeVisible();
  source = 'discovery';
  await page.getByRole('combobox', { name: 'Sort canonical market' }).selectOption('variants');
  await expect(page.getByText(/discovery index: unavailable/)).toBeVisible();
  source = 'price';
  await page.getByRole('combobox', { name: 'Sort canonical market' }).selectOption('reportedCap');
  await expect(page.getByText(/Price V3: unavailable/)).toBeVisible();
  source = 'total';
  await page.getByRole('combobox', { name: 'Sort canonical market' }).selectOption('price');
  await expect(page.getByText('Dated reviewed catalog fallback.')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  source = 'recovered';
  await page.getByRole('combobox', { name: 'Sort canonical market' }).selectOption('name');
  await expect(page.getByText('Dated reviewed catalog fallback.')).not.toBeVisible();
  await expect(page.getByText('Partial market coverage.')).not.toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
});
