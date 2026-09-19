import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { StockMarketPage, StockMarketRecord } from '../../src/domain/stocks';

const observedAt = '2026-09-16T04:00:00.000Z';
const source = { label: 'Jupiter Tokens V2', url: 'https://developers.jup.ag/docs/tokens/token-information', observedAt, retrievedAt: observedAt };
const records: StockMarketRecord[] = [{
  mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', tokenName: 'NVIDIA xStock', tokenSymbol: 'NVDAx', logoUrl: 'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png',
  identityClass: 'issuer-confirmed-xstock', assetType: 'equity', issuerName: 'Backed Assets (JE) Limited', issuerVerified: true,
  underlyingSymbol: 'NVDA', underlyingIsin: 'US67066G1040', listingCountry: 'US', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 8,
  priceUsd: '178.42', priceChange24hPct: '1.29', liquidityUsd: '1234567.89', volume24hUsd: '456789.12', tokenizedMarketCapUsd: '9876543.21', holderCount: 1204,
  marketUpdatedAt: observedAt, priceUpdatedAt: observedAt, retrievedAt: observedAt,
  sources: [{ label: 'xStocks public asset registry', url: 'https://api.xstocks.fi/api/v2/public/assets/NVDAx', observedAt: null, retrievedAt: observedAt }, source], warnings: [],
}, {
  mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', tokenName: 'Tesla xStock', tokenSymbol: 'TSLAx', logoUrl: null,
  identityClass: 'issuer-confirmed-xstock', assetType: 'equity', issuerName: 'Backed Assets (JE) Limited', issuerVerified: true,
  underlyingSymbol: 'TSLA', underlyingIsin: 'US88160R1014', listingCountry: 'US', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 8,
  priceUsd: null, priceChange24hPct: null, liquidityUsd: null, volume24hUsd: null, tokenizedMarketCapUsd: null, holderCount: null,
  marketUpdatedAt: null, priceUpdatedAt: null, retrievedAt: observedAt, sources: [{ label: 'xStocks public asset registry', url: 'https://api.xstocks.fi/api/v2/public/assets/TSLAx', observedAt, retrievedAt: observedAt }],
  warnings: ['Onchain Jupiter USD price is unavailable; it is not treated as zero.'],
}];

function fixture(overrides: Partial<StockMarketPage> = {}): StockMarketPage {
  return { status: 'ready', records, pagination: { page: 1, pageSize: 20, total: 300, totalPages: 15 },
    summary: { discovered: 300, issuerConfirmed: 300, priceAvailable: 137, liquidMarkets: 86, liquidityUsd: '1234567.89', volume24hUsd: '456789.12' },
    providers: { xstocks: 'ready', jupiterTokens: 'ready', jupiterPrice: 'partial' },
    cache: { universe: 'hit', visiblePrices: 'hit', universeExpiresAt: '2026-09-16T05:00:00.000Z', priceWorker: {
      status: 'refreshing', cached: 137, target: 300, batchSize: 50, cycleSeconds: 30,
      lastBatchAt: observedAt, lastCycleCompletedAt: observedAt, nextRunAt: '2026-09-16T04:00:30.000Z',
    } },
    updatedAt: observedAt, issues: [], ...overrides };
}

async function screenshot(page: Page, name: string) {
  await mkdir('docs/evidence/free-read-only-phase2/screens', { recursive: true });
  await page.evaluate(() => { window.scrollTo(0, 0); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.screenshot({ path: `docs/evidence/free-read-only-phase2/screens/${name}.png`, fullPage: true });
}

async function openStocks(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tokenized Stock Prices on Solana' })).toBeVisible();
}

test('wallet-independent stocks page renders core fields, controls, and details', async ({ page }) => {
  const requests: string[] = [];
  await page.route('https://xstocks-metadata.backed.fi/logos/tokens/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#48b7a0"/></svg>' }));
  await page.route('**/api/markets/stocks**', route => { requests.push(route.request().url()); return route.fulfill({ json: fixture() }); });
  await openStocks(page);
  await expect(page.getByText('No wallet required · read only · exact issuer mints')).toBeVisible();
  await expect(page.getByText('Sample portfolio · simulated values')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Tokenized market cap' })).toBeVisible();
  await expect(page.locator('.market-table').getByText('$178.42', { exact: true })).toBeVisible();
  await expect(page.locator('.market-table').getByText('+1.29%', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View NVIDIA xStock details' }).locator('img')).toHaveAttribute('src', 'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png');
  await expect(page.getByText('—', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Asset type')).toBeVisible();
  await expect(page.getByLabel('Issuer verification')).toHaveCount(0);
  await expect(page.getByLabel('Price availability')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prioritize visible' })).toHaveCount(0);
  expect(requests.every(request => !new URL(request).searchParams.has('refresh'))).toBe(true);
  await page.getByRole('button', { name: 'View NVIDIA xStock details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('US67066G1040');
  await expect(drawer).toContainText('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  await expect(drawer).toContainText('Tokenized market cap');
  await page.keyboard.press('Escape');
  await page.getByLabel('Search tokenized stocks').fill('NVDA');
  await expect.poll(() => requests.length ? new URL(requests.at(-1)!).searchParams.get('search') : null).toBe('NVDA');
  await page.reload();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View NVIDIA xStock details' })).toBeVisible();
  expect(requests.every(request => !new URL(request).searchParams.has('refresh'))).toBe(true);
  await screenshot(page, 'stocks-no-wallet-desktop-mocked');
});

test('portfolio failure cannot block the public Stocks page', async ({ page }) => {
  await page.route('**/api/portfolio', route => route.fulfill({ status: 502, json: { status: 'error', code: 'RPC_FAILED', message: 'Fixture wallet RPC failed.' } }));
  await page.route('**/api/markets/stocks**', route => route.fulfill({ json: fixture() }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.getByText('Read a public address', { exact: true }).click();
  await page.getByLabel('Solana wallet address').fill('11111111111111111111111111111111');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Live data couldn’t be loaded' })).toBeVisible();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View NVIDIA xStock details' })).toBeVisible();
  await expect(page.getByText('Fixture wallet RPC failed.')).toHaveCount(0);
  await screenshot(page, 'stocks-independent-of-wallet-error-mocked');
});

test('partial provider state is explicit and mobile cards do not overflow', async ({ page }) => {
  await page.route('**/api/markets/stocks**', route => route.fulfill({ json: fixture({ status: 'partial', providers: { xstocks: 'ready', jupiterTokens: 'unavailable', jupiterPrice: 'partial' }, issues: ['Jupiter exact-mint token metadata is temporarily unavailable. Issuer identity remains verified.'] }) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await openStocks(page);
  await expect(page.getByText('Some market sources are unavailable.')).toBeVisible();
  await expect(page.locator('.market-cards')).toBeVisible();
  await expect(page.locator('.market-table-wrap')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.market-card').first().click();
  await expect(page.getByRole('dialog')).toContainText('Holder count');
  await page.keyboard.press('Escape');
  await screenshot(page, 'stocks-mobile-partial-mocked');
});

test('market failure and retry are isolated, with no portfolio substitution', async ({ page }) => {
  let available = false;
  await page.route('**/api/markets/stocks**', route => {
    return available ? route.fulfill({ json: fixture() }) : route.fulfill({ status: 503, json: { status: 'error', message: 'Unavailable' } });
  });
  await openStocks(page);
  await expect(page.getByRole('heading', { name: 'Market data couldn’t be loaded' })).toBeVisible();
  await expect(page.getByText('$19,200.00', { exact: true })).toHaveCount(0);
  available = true; await page.getByRole('button', { name: /Try cached market read/ }).click();
  await expect(page.getByRole('button', { name: 'View NVIDIA xStock details' })).toBeVisible();
});

test('market route rejects generic upstream proxy parameters before any provider read', async ({ request }) => {
  const response = await request.get('/api/markets/stocks?upstream=https%3A%2F%2Fexample.com&apiKey=secret');
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ status: 'error', message: 'Invalid market query.' });
  const invalidRefresh = await request.get('/api/markets/stocks?refresh=all');
  expect(invalidRefresh.status()).toBe(400);
  const visitorRefresh = await request.get('/api/markets/stocks?refresh=visible');
  expect(visitorRefresh.status()).toBe(400);
});
