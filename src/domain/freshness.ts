import type { Portfolio } from './types';
// Application policy, not a guarantee of oracle/feed freshness.
export const ACCOUNT_MAX_AGE_MS = 120000;
// Refresh visible live risk views with headroom before the two-minute
// fail-closed boundary. Hidden tabs remain fully on demand.
export const LIVE_FOREGROUND_REFRESH_MS = 90000;
export function isSnapshotStale(portfolio: Portfolio, now = Date.now()): boolean {
  if (portfolio.mode === 'sample') return false;
  return now - Date.parse(portfolio.observedAt) > ACCOUNT_MAX_AGE_MS || portfolio.loans.some(l => l.source.validity === 'stale');
}
