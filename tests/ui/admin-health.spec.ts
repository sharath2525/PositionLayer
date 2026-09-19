import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const authorization = `Basic ${Buffer.from('health-test:health-test-password').toString('base64')}`;

test('admin health is protected, private, responsive, and makes no provider request', async ({ page, request }) => {
  const hydrationErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /hydration failed/i.test(message.text())) hydrationErrors.push(message.text()); });
  const unauthorized = await request.get('/admin/health');
  expect(unauthorized.status()).toBe(401);
  expect(unauthorized.headers()['www-authenticate']).toContain('Basic');
  expect(unauthorized.headers()['cache-control']).toContain('no-store');
  expect(unauthorized.headers()['x-frame-options']).toBe('DENY');

  const upstream: string[] = [];
  page.on('request', current => { if (/api\.jup\.ag|api\.xstocks\.fi|solana\.com/.test(current.url())) upstream.push(current.url()); });
  await page.setExtraHTTPHeaders({ authorization });
  await page.goto('/admin/health');
  await expect(page.getByRole('heading', { name: 'Market engine health' })).toBeVisible();
  await expect(page.getByText('Six sequential batches of 50')).toBeVisible();
  expect(upstream).toEqual([]);
  await mkdir('docs/evidence/observability-phase1', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/observability-phase1/admin-health-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Market engine health' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: 'docs/evidence/observability-phase1/admin-health-mobile.png', fullPage: true });
  expect(hydrationErrors).toEqual([]);
});
