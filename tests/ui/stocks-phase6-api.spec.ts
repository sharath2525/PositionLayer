import { test, expect } from '@playwright/test';

test('versioned canonical market API is bounded, wallet-independent, and distinct from mint detail', async ({ request }) => {
  const pageResponse = await request.get('/api/markets/v2/stocks?pageSize=5&sort=name');
  expect(pageResponse.status()).toBe(200);
  const page = await pageResponse.json();
  expect(page.version).toBe(2);
  expect(page.pagination.pageSize).toBe(5);
  expect(page.records.length).toBeLessThanOrEqual(5);
  expect(page.summary.exactMintCount).toBeGreaterThan(0);
  expect(page.summary.verifiedUnderlyingCount).toBeLessThanOrEqual(page.summary.canonicalCount);
  expect(page.prices).toHaveProperty('failedBatchCount');
  expect(page.summary.coveredSolanaTokenizedCap).toHaveProperty('basis');

  const detailResponse = await request.get(`/api/markets/v2/assets/${encodeURIComponent(page.records[0].id)}`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json();
  expect(detail.version).toBe(2);
  expect(detail.asset.id).toBe(page.records[0].id);
  expect(detail.variants.length).toBeGreaterThan(0);

  expect((await request.get('/api/markets/v2/stocks?pageSize=51')).status()).toBe(400);
  expect((await request.get('/api/markets/v2/stocks?upstream=https://example.com')).status()).toBe(400);
  expect((await request.get('/api/markets/v2/assets/not-an-asset')).status()).toBe(400);
});
