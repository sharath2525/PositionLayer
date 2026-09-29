import type { z } from 'zod';
import type { CanonicalMarketPageSchema, CanonicalMarketDetailSchema } from './market-api-v2';
import type { DisplayTokenPrice, VariantPriceDecision } from './market-price-policy';
import { ageRichData } from './stock-rich-data';

/** Re-age cached/browser values without refreshing their source timestamps. */
export function ageDisplayPrice(value: DisplayTokenPrice, now: number): DisplayTokenPrice {
  if (value.status === 'UNAVAILABLE' || !value.observedAt) return value;
  const age = now - Date.parse(value.observedAt);
  if (age > 600_000 || age < -5_000) return { ...value, status: 'UNAVAILABLE', priceUsd: null,
    source: null, reason: age < 0 ? 'future-dated' : 'stale-price' };
  return { ...value, status: age <= 45_000 ? 'LIVE' : age <= 120_000 ? 'DELAYED' : 'STALE' };
}
function ageEligible(value: VariantPriceDecision, now: number): VariantPriceDecision {
  if (value.status === 'blocked') return value;
  const age = now - Date.parse(value.providerObservedAt);
  return age > 45_000 || age < -5_000 ? { status: 'blocked', mint: value.mint,
    reason: age < 0 ? 'future-dated' : 'stale-price' } : { ...value, ageMs: Math.max(0, age) };
}
export function ageCanonicalPage(input: z.infer<typeof CanonicalMarketPageSchema>, now = Date.now(), outage = false) {
  const page = structuredClone(input);
  for (const row of page.records) {
    row.rich=ageRichData(row.rich,now);
    if (row.marketStatus !== 'halted' && (!row.marketStatusValidUntil || Date.parse(row.marketStatusValidUntil) <= now)) row.marketStatus = 'unknown';
    row.displayPrice = ageDisplayPrice(row.displayPrice, now);
    if (row.price && (now - Date.parse(row.price.observedAt) > 45_000 || now - Date.parse(row.price.observedAt) < -5_000)) {
      row.price = null; row.priceUnavailableReason = 'stale-price';
    }
  }
  page.ticker = (page.ticker ?? []).map(row => {
    const age = row.change24h ? now - Date.parse(row.change24h.observedAt ?? row.change24h.retrievedAt) : Infinity;
    return { ...row, displayPrice: ageDisplayPrice(row.displayPrice, now),
      change24h: age >= -5000 && age <= 600_000 ? row.change24h : null };
  }).filter(row => row.displayPrice.priceUsd !== null);
  if (outage || (page.prices.completedAt && now - Date.parse(page.prices.completedAt) > 120_000)) {
    page.status = 'degraded'; page.providers.jupiterPrice = 'stale';
    if (outage) page.source = 'local-previous';
  }
  return page;
}
export function ageCanonicalDetail(input: z.infer<typeof CanonicalMarketDetailSchema>, now = Date.now(), outage = false) {
  const detail = structuredClone(input);
  for (const row of detail.variants) {
    row.rich=ageRichData(row.rich,now);
    row.displayPrice = ageDisplayPrice(row.displayPrice, now);
    row.tokenPrice = ageEligible(row.tokenPrice, now);
  }
  const candidates = detail.selectedPrice.candidates.map(value => ageEligible(value, now));
  const selected = candidates.find((value): value is Extract<VariantPriceDecision, { status: 'eligible' }> => value.status === 'eligible') ?? null;
  detail.selectedPrice = { ...detail.selectedPrice, candidates, selected,
    status: selected ? 'selected' : 'unavailable', reason: selected ? null : detail.selectedPrice.reason ?? 'stale-price',
    comparison: candidates.some(row => row.status === 'blocked') ? {
      status: 'NOT_COMPARABLE', reason: 'stale-observation', differencePct: null, comparedMints: [] } : detail.selectedPrice.comparison };
  if (outage) { detail.degraded = true; detail.source = 'local-previous'; }
  return detail;
}
