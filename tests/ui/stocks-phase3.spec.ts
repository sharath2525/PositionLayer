import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { StockMarketDetail, StockMarketPage, StockMarketRecord } from '../../src/domain/stocks';

const observedAt = '2026-09-16T12:00:00.000Z';
const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const record: StockMarketRecord = {
  mint, tokenName: 'NVIDIA xStock', tokenSymbol: 'NVDAx', issuerSymbol: 'NVDAx', logoUrl: null,
  identityClass: 'issuer-confirmed-xstock', assetType: 'equity', issuerName: 'Backed Assets (JE) Limited', issuerVerified: true,
  underlyingSymbol: 'NVDA', underlyingIsin: 'US67066G1040', listingCountry: 'US',
  tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 8,
  priceUsd: '110', priceSource: 'jupiter-price-v3', priceChange24hPct: '1.29', liquidityUsd: '1234567.89', volume24hUsd: '456789.12',
  tokenizedMarketCapUsd: '9876543.21', holderCount: 1204, marketUpdatedAt: observedAt, priceUpdatedAt: observedAt, retrievedAt: observedAt,
  sources: [
    { label: 'xStocks public asset registry', url: 'https://api.xstocks.fi/api/v2/public/assets/NVDAx', observedAt, retrievedAt: observedAt },
    { label: 'Jupiter Price V3', url: 'https://developers.jup.ag/docs/price', observedAt: null, retrievedAt: observedAt },
  ], warnings: [],
  marketObservation: { source: 'jupiter-price-v3', mint, currency: 'USD', priceUsd: '110', lastKnownPriceUsd: '110', priceChange24hPct: '1.29', blockId: 42, decimals: 8, retrievedAt: observedAt, freshness: 'LIVE', eligibleForSensitiveUse: true, updateFailure: null },
  intelligence: {
    issuerIndicativePriceUsd: '100', issuerPriceRetrievedAt: observedAt,
    issuerPriceSourceUrl: 'https://api.xstocks.fi/api/v2/public/assets/NVDAx/price-data',
    market: { period: 'market', openNow: true, tradingHalted: false, currency: 'USD', nextChangeAt: null },
    multiplier: { status: 'current', current: '1.0057', pending: null, activationAt: null, reason: null },
    premiumDiscount: { status: 'available', valuePct: '10', reason: null, label: 'estimated', jupiterRetrievedAt: observedAt, issuerRetrievedAt: observedAt },
    lend: { status: 'available', vaults: [{ vaultId: 80, borrowMint: usdc, borrowSymbol: 'USDC', maxBorrowLtv: '0.75', liquidationThreshold: '0.8' }], observedAt, sourceUrl: 'https://developers.jup.ag/docs/lend/borrow/api' },
    supply: null, reserve: null,
  },
};

const detail: StockMarketDetail = {
  status: 'ready', issues: [], record: { ...record, intelligence: { ...record.intelligence!,
    supply: { circulating: '1000000', total: '1100000', scope: 'all-xstocks-chain-deployments', retrievedAt: observedAt },
    reserve: { status: 'available', timestamp: observedAt, sharesHeld: '1000000', circulatingSupply: '1000000', holdings: [{ provider: 'fixture custodian', quantity: '1000000', symbol: 'NVDA' }], retrievedAt: observedAt, sourceUrl: 'https://api.xstocks.fi/api/v2/public/proof-of-reserves/NVDAx' },
  } }, marketEvidence: {
    selectedSource: 'jupiter-price-v3', selectedFreshness: 'LIVE', lastSuccessfulMarketUpdate: observedAt,
    meteoraPool: { source: 'meteora-dlmm', poolAddress: 'F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a', stockMint: mint, quoteMint: usdc, quoteSymbol: 'USDC', orientation: 'stock-x', pairPrice: '108', priceUsd: '108', tvlUsd: '125000', liquidityUsd: '125000', volume24hUsd: '45000', fees24hUsd: '90', blacklisted: false, providerObservedAt: null, retrievedAt: observedAt, sourceUrl: 'https://dlmm.datapi.meteora.ag/pools/F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a' },
    comparison: { status: 'AGREE', reason: null, differencePct: '1.83486239', divergenceThresholdPct: '5', jupiterPriceUsd: '110', meteoraPriceUsd: '108' },
    meteoraFallbackActive: false,
  },
};

const market: StockMarketPage = {
  status: 'ready', records: [record], pagination: { page: 1, pageSize: 20, total: 300, totalPages: 15 },
  summary: { discovered: 300, issuerConfirmed: 300, priceAvailable: 241, priceV3Available: 241, referencePriceAvailable: 0, liquidMarkets: 113, liquidityUsd: '1234567.89', volume24hUsd: '456789.12', tokenizedMarketCapUsd: '9876543.21', tokenizedMarketCapCoverage: 1 },
  providers: { xstocks: 'ready', jupiterTokens: 'ready', jupiterPrice: 'partial', xstocksIntelligence: 'ready', jupiterLend: 'ready' },
  cache: { universe: 'hit', visiblePrices: 'hit', universeExpiresAt: '2026-09-16T13:00:00.000Z', priceWorker: {
    status: 'refreshing', cached: 241, target: 300, batchSize: 50, cycleSeconds: 30,
    lastBatchAt: observedAt, lastCycleCompletedAt: observedAt, nextRunAt: '2026-09-16T12:00:30.000Z',
  } }, updatedAt: observedAt, issues: [],
};

async function openStocks(page: Page, marketFixture: StockMarketPage = market, detailFixture: StockMarketDetail = detail, withSample = false) {
  await page.route('**/api/markets/stocks**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === `/api/markets/stocks/${mint}` ? detailFixture : marketFixture });
  });
  await page.goto('/');
  if (withSample) await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tokenized Stock Prices on Solana' })).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  await mkdir('docs/evidence/free-read-only-phase3/screens', { recursive: true });
  await page.screenshot({ path: `docs/evidence/free-read-only-phase3/screens/${name}.png`, fullPage: true });
}

test('Phase 3 shows safely gated intelligence, exact-mint Lend, local holding context, and detail sources', async ({ page }) => {
  await openStocks(page, market, detail, true);
  await expect(page.getByText('Verified universe', { exact: true })).toBeVisible();
  await expect(page.getByText('Liquid markets', { exact: true })).toBeVisible();
  await expect(page.getByText('113', { exact: true })).toBeVisible();
  await expect(page.locator('.market-table')).toContainText('Company market cap');
  await expect(page.locator('.market-table')).toContainText('$9,876,543.21');
  await expect(page.locator('.market-cap-note')).toContainText('cannot be derived from tokenized cap');
  await expect(page.locator('.market-table').getByText('Premium +10.00%', { exact: true })).toBeVisible();
  await expect(page.locator('.market-table').getByText('Lend available', { exact: true })).toBeVisible();
  await expect(page.locator('.market-table').getByText('In this portfolio', { exact: true })).toBeVisible();
  await expect(page.locator('.market-table').getByText('Price V3 · LIVE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View NVIDIA xStock details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Identity' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Selected market observation' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Onchain liquidity' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Issuer reference' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Local wallet context' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'Data quality and sources' })).toBeVisible();
  await expect(drawer).toContainText('Issuer indicative price');
  await expect(drawer).toContainText('Premium +10.00%');
  await expect(drawer).toContainText('Available · vault 80 · borrow USDC');
  await expect(drawer).toContainText('Meteora verified pool');
  await expect(drawer).toContainText('DLMM · USDC');
  await expect(drawer).toContainText('AGREE');
  await expect(drawer).toContainText('1,000,000.00 · all xStocks chain deployments');
  await expect(drawer).toContainText('never arbitrage or guaranteed execution');
  await screenshot(page, 'phase3-intelligence-detail-desktop');
  await drawer.getByRole('button', { name: 'View portfolio' }).click();
  await expect(page.getByRole('heading', { name: 'Your whole portfolio.' })).toBeVisible();
});

test('Phase 3 mobile cards remain readable and preserve estimated labeling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStocks(page);
  await expect(page.locator('.market-cards')).toBeVisible();
  await expect(page.locator('.market-table-wrap')).toBeHidden();
  await expect(page.locator('.market-card').first().getByText('Premium +10.00%', { exact: true })).toBeVisible();
  await expect(page.locator('.market-card').first()).toContainText('LIVE');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.market-card').first().click();
  await expect(page.getByRole('dialog')).toContainText('Meteora verified pool');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, 'phase3-intelligence-mobile');
});

test('Phase 3 restores keyboard focus and safely falls back when a verified logo cannot load', async ({ page }) => {
  const withLogo: StockMarketRecord = { ...record, logoUrl: 'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png' };
  const withLogoMarket: StockMarketPage = { ...market, records: [withLogo] };
  const withLogoDetail: StockMarketDetail = { ...detail, record: { ...detail.record, logoUrl: withLogo.logoUrl } };
  await page.route('https://xstocks-metadata.backed.fi/logos/tokens/**', route => route.fulfill({ status: 404, body: '' }));
  await openStocks(page, withLogoMarket, withLogoDetail);
  const trigger = page.getByRole('button', { name: 'View NVIDIA xStock details' });
  await expect(trigger.locator('[data-logo-state="initials-fallback"]')).toContainText('NV');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Phase 3 explains stale and blocked comparison states without substituting zero', async ({ page }) => {
  const staleRecord: StockMarketRecord = {
    ...record,
    priceUsd: '110',
    marketObservation: { ...record.marketObservation!, freshness: 'STALE', eligibleForSensitiveUse: false, updateFailure: { kind: 'omitted', at: observedAt, message: 'Jupiter omitted this mint in the latest batch.' } },
  };
  const staleMarket: StockMarketPage = { ...market, status: 'stale', records: [staleRecord], issues: ['Jupiter is serving a dated last-known-good observation.'] };
  const blockedDetail: StockMarketDetail = {
    ...detail,
    record: staleRecord,
    marketEvidence: { ...detail.marketEvidence!, selectedFreshness: 'STALE', comparison: { ...detail.marketEvidence!.comparison, status: 'NOT_COMPARABLE', reason: 'jupiter-not-live', differencePct: null } },
  };
  await openStocks(page, staleMarket, blockedDetail);
  await expect(page.locator('.market-table').getByText('Price V3 · STALE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View NVIDIA xStock details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Display only or unavailable');
  await expect(drawer).toContainText('Jupiter omitted this mint in the latest batch.');
  await expect(drawer).toContainText('NOT_COMPARABLE');
  await expect(drawer).toContainText('Jupiter price is not live');
  await expect(drawer).not.toContainText('$0.00');
});

test('Tokens V2 reference quotes remain visibly separate and display-only', async ({ page }) => {
  const referenceRecord: StockMarketRecord = {
    ...record,
    priceUsd: '108', priceSource: 'jupiter-tokens-v2-reference', referencePriceUsd: '108',
    referencePriceChange24hPct: '0.3', referencePriceRetrievedAt: observedAt,
    priceChange24hPct: '0.3',
    marketObservation: { ...record.marketObservation!, priceUsd: null, lastKnownPriceUsd: null, priceChange24hPct: null,
      blockId: null, retrievedAt: null, freshness: 'UNAVAILABLE', eligibleForSensitiveUse: false },
    intelligence: { ...record.intelligence!, premiumDiscount: { ...record.intelligence!.premiumDiscount, status: 'unavailable', valuePct: null, reason: 'no-jupiter-price' } },
    sources: record.sources.filter(source => source.label !== 'Jupiter Price V3'),
  };
  const referenceMarket: StockMarketPage = { ...market, records: [referenceRecord], summary: { ...market.summary, priceV3Available: 0, referencePriceAvailable: 1 } };
  await openStocks(page, referenceMarket, { ...detail, record: referenceRecord });
  await expect(page.locator('.market-table').getByText('Tokens V2 · display only · REFERENCE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View NVIDIA xStock details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Selected display source · Tokens V2 · display only');
  await expect(drawer).toContainText('Display only or unavailable');
  await expect(drawer).toContainText('Original company market cap');
  await expect(drawer).not.toContainText('Premium +10.00%');
});
