import { expect, it } from 'vitest';
import { recordSessionPrices, type SessionHistory } from '@/domain/stock-session-trend';
import type { DisplayTokenPrice } from '@/domain/market-price-policy';

const at = Date.parse('2026-09-28T00:00:00Z');
function observation(index: number, mint = 'mint-a', status: DisplayTokenPrice['status'] = 'LIVE') {
  const displayPrice: DisplayTokenPrice = { mint, status, priceUsd: String(index + 1),
    observedAt: new Date(at + index * 1000).toISOString(), retrievedAt: new Date(at + index * 1000).toISOString(),
    source: 'jupiter-price-v3', reason: null, eligibleForSensitiveUse: false };
  return { displayPrice };
}
it('records new exact-mint observations once across page/ticker reads, never aging or replay points', () => {
  const history: SessionHistory = new Map();
  recordSessionPrices(history, { records: [observation(0)], ticker: [observation(0)] });
  recordSessionPrices(history, { records: [observation(1)], ticker: [] });
  recordSessionPrices(history, { records: [observation(0), observation(2, 'mint-a', 'STALE')], ticker: [] });
  expect(history.get('mint-a')?.map(point => point.value)).toEqual([1, 2]);
  recordSessionPrices(history, { records: [observation(3, 'mint-b')], ticker: [] });
  expect(history.get('mint-b')).toHaveLength(1);
});
it('bounds session memory across long browsing and many identities', () => {
  const history: SessionHistory = new Map();
  for (let index = 0; index < 200; index++) recordSessionPrices(history, { records: [observation(index)], ticker: [] });
  expect(history.get('mint-a')).toHaveLength(90);
  expect(history.get('mint-a')![0].value).toBe(111);
  for (let index = 0; index < 301; index++) recordSessionPrices(history, { records: [observation(1, `mint-${index}`)], ticker: [] });
  expect(history.size).toBe(300);
  expect(history.has('mint-a')).toBe(false);
});
