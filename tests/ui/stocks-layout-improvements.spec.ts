import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('Stocks focus, Listed columns, filters and top-20 ticker share one refreshed snapshot', async ({ page, request }) => {
  const base = await (await request.get('/api/markets/v2/stocks?pageSize=20')).json();
  const row = structuredClone(base.records[0]);
  const now = new Date().toISOString();
  row.tokenSymbol = 'CHECKx'; row.listingCountry = 'GB'; row.listingCurrency = 'GBP'; row.listingExchange = 'LSE';
  row.marketStatus = 'closed'; row.marketStatusValidUntil = new Date(Date.now() + 3600_000).toISOString();
  row.displayPrice = { ...row.displayPrice, priceUsd: '42', status: 'LIVE', source: 'jupiter-price-v3',
    observedAt: now, retrievedAt: now, reason: null };
  row.marketData = { mint: row.variantMints[0], source: 'jupiter-price-v3', referencePrice: null,
    companyCap: null, liquidity: null, change24h: { value: 3.25, retrievedAt: now, currency: null },
    multiplier: null, circulatingPrescaled: null, totalPrescaled: null };
  let version = 1;
  let holdNextRead = false;
  let finishRead: (() => void) | undefined;
  const queries: URLSearchParams[] = [];
  const external: string[] = [];
  page.on('request', current => { if (/api\.jup\.ag|api\.xstocks\.fi/.test(current.url())) external.push(current.url()); });
  await page.route('https://xstocks-metadata.backed.fi/**', route => route.abort());
  await page.route('**/api/markets/v2/stocks?**', async route => {
    if (holdNextRead) {
      holdNextRead = false;
      await new Promise<void>(resolve => { finishRead = resolve; });
    }
    queries.push(new URL(route.request().url()).searchParams);
    const displayPrice = { ...row.displayPrice, priceUsd: String(41 + version) };
    return route.fulfill({ json: { ...base, status: 'ready', source: 'current',
      prices: { ...base.prices, snapshotId: `layout-${version}`, completedAt: now },
      summary: { ...base.summary, displayPriceLiveMintCount: 20, displayPriceDelayedMintCount: 0,
        displayPriceStaleMintCount: 0, reportedTokenizedCapUsd: '2390000000', reportedCapMintCount: 20 },
      facets: { countries: ['GB', 'US'], currencies: ['GBP', 'USD'] },
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 }, records: [{ ...row, displayPrice }],
      ticker: Array.from({ length: 20 }, (_, index) => ({ id: index ? `fixture-${index}` : row.id,
        symbol: index ? `CHECK${index}x` : row.tokenSymbol, name: row.name, displayPrice, change24h: row.marketData.change24h })),
    } });
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Stocks', exact: true }).click();
  await expect(page.locator('.canonical-summary>div')).toHaveCount(4);
  await expect(page.getByText('Stock market · tokenized and listed', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Onchain-price available', { exact: true })).toBeVisible();
  await expect(page.locator('.canonical-summary').getByText(`20/${base.summary.exactMintCount}`, { exact: true })).toBeVisible();
  const table = page.locator('.canonical-market table');
  expect(await table.locator('tr').evaluateAll(rows => rows.some(row =>
    Array.from(row.childNodes).some(node => node.nodeType === Node.TEXT_NODE)))).toBe(false);
  expect((await table.boundingBox())!.y).toBeLessThan(750);
  expect(await page.locator('.canonical-coverage-details').evaluate(el => Boolean(el.previousElementSibling?.classList.contains('market-panel')))).toBe(true);
  const ticker = page.getByRole('complementary', { name: 'Top 20 companies by market cap' });
  await expect(ticker.locator('button.ticker-quote')).toHaveCount(20);
  expect((await ticker.boundingBox())!.y).toBe(0);
  await expect(ticker).toHaveAttribute('data-snapshot-id', 'layout-1');
  await expect(ticker.locator('button.ticker-quote').first()).toContainText('$42.00');
  await expect(table).toContainText('$42.00');
  expect(await ticker.locator('.ticker-track').evaluate(el => getComputedStyle(el).animationName)).toBe('stocks-ticker-scroll');
  await ticker.hover();
  expect(await ticker.locator('.ticker-track').evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.getByRole('button', { name: 'Pause ticker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume ticker' })).toHaveAttribute('aria-pressed', 'true');
  version = 2;
  holdNextRead = true;
  const tableTop = (await table.boundingBox())!.y;
  await page.clock.fastForward(30_000);
  await expect(page.getByRole('button', { name: 'Refresh snapshot' })).toHaveCount(0);
  expect((await table.boundingBox())!.y).toBe(tableTop);
  await expect.poll(() => Boolean(finishRead)).toBe(true);
  finishRead!();
  await expect(ticker).toHaveAttribute('data-snapshot-id', 'layout-2');
  await expect(page.locator('.canonical-market .market-panel')).toHaveAttribute('data-snapshot-id', 'layout-2');
  await expect(ticker.locator('button.ticker-quote').first()).toContainText('$43.00');
  await expect(table).toContainText('$43.00');
  version = 3;
  await page.clock.runFor(30_000);
  await expect(ticker).toHaveAttribute('data-snapshot-id', 'layout-3');
  await expect(page.locator('.canonical-market .market-panel')).toHaveAttribute('data-snapshot-id', 'layout-3');
  await expect(ticker.locator('button.ticker-quote').first()).toContainText('$44.00');
  await expect(table).toContainText('$44.00');
  await mkdir('docs/evidence/stocks-layout-improvements', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/stocks-layout-improvements/tokenized-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Listed', exact: true }).click();
  const columns = ['Company', 'Price', '24h %', 'Last 5d', 'MC', '24h Vol', 'Token', 'Underlying', 'Market', 'Exchange'];
  await expect(page.locator('.listed-table th')).toHaveText(columns);
  await expect(page.locator('.listed-table tbody tr td').nth(2)).toHaveText('—');
  await expect(page.locator('.listed-table tbody tr td').nth(3)).toHaveText('—');
  await expect(page.locator('.listed-table tbody tr td').nth(5)).toHaveText('—');
  await page.getByLabel('Market status', { exact: true }).selectOption('closed');
  await page.getByLabel('Listing country', { exact: true }).selectOption('GB');
  await page.getByLabel('Listing currency', { exact: true }).selectOption('GBP');
  await expect.poll(() => queries.some(q => q.get('view') === 'listed' && q.get('market') === 'closed'
    && q.get('country') === 'GB' && q.get('currency') === 'GBP' && q.get('page') === '1')).toBe(true);
  await page.locator('.market-columns summary').click();
  await page.getByRole('checkbox', { name: 'Last 5d', exact: true }).uncheck();
  await expect(page.getByRole('columnheader', { name: 'Last 5d' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Last 5d', exact: true }).check();
  await page.locator('.market-columns summary').click();
  await page.screenshot({ path: 'docs/evidence/stocks-layout-improvements/listed-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: /Switch to dark mode/ }).click();
  await page.screenshot({ path: 'docs/evidence/stocks-layout-improvements/listed-dark.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.canonical-market .market-cards')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('.listed-card-fields')).not.toContainText('token change');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await ticker.locator('.ticker-track').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: 'docs/evidence/stocks-layout-improvements/listed-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(ticker).toHaveCount(1);
  await expect(page.locator('.app-shell')).not.toHaveClass(/stocks-workspace/);
  await expect(page.locator('.app-shell')).toHaveClass(/stocks-ticker-enabled/);
  expect(external).toEqual([]);
});
