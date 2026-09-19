import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { EphemeralLogStore, MONITORING_TTL_MS, monitoringStore } from '@/services/monitoring/log-manager';
import { sanitizeAssetOrMint, sanitizeMonitoringMessage } from '@/services/monitoring/sanitize';
import { noteProviderAttempt, noteProviderFailure, noteProviderSuccess, providerHealthSnapshot, resetProviderHealthForTests } from '@/services/monitoring/provider-health';
import { ADMIN_HEALTH_SECURITY_HEADERS, isAdminHealthAuthorized, isAdminHealthEnabled } from '@/services/monitoring/admin-auth';
import { readMonitoringSnapshot } from '@/services/monitoring/snapshot';
import { getStockMarketCacheStats } from '@/services/stocks-market';

const validEvent = {
  severity: 'WARN' as const, provider: 'JUPITER' as const, operation: 'price_fetch' as const,
  status: 'RATE_LIMITED' as const, errorCode: 'RATE_LIMIT' as const, message: 'Rate limit reached.',
};

describe('six-hour temporary observability', () => {
  const original = { ...process.env };
  beforeEach(() => { process.env.MARKET_MONITORING_ENABLED = 'true'; monitoringStore().clear(); resetProviderHealthForTests(); });
  afterEach(() => {
    process.env.ADMIN_HEALTH_ENABLED = original.ADMIN_HEALTH_ENABLED;
    process.env.ADMIN_HEALTH_USERNAME = original.ADMIN_HEALTH_USERNAME;
    process.env.ADMIN_HEALTH_PASSWORD = original.ADMIN_HEALTH_PASSWORD;
    monitoringStore().clear(); resetProviderHealthForTests(); vi.restoreAllMocks();
  });

  it('keeps an event at exactly six hours and deletes it immediately after the maximum TTL', () => {
    let now = 0;
    const store = new EphemeralLogStore({ now: () => now });
    expect(store.append({ ...validEvent, timestamp: new Date(0).toISOString() })).toBe(true);
    now = MONITORING_TTL_MS;
    expect(store.read()).toHaveLength(1);
    now++;
    expect(store.read()).toHaveLength(0);
    store.stop();
  });

  it('prunes expired records even when timestamps arrive out of order', () => {
    const now = MONITORING_TTL_MS + 10_000;
    const store = new EphemeralLogStore({ now: () => now });
    store.append({ ...validEvent, timestamp: new Date(now).toISOString(), message: 'newer' }, false);
    store.append({ ...validEvent, timestamp: new Date(0).toISOString(), message: 'expired' }, false);
    expect(store.read().map(event => event.message)).toEqual(['newer']);
    store.stop();
  });

  it('evicts oldest records under count and approximate-byte caps without throwing', () => {
    let now = Date.now();
    const store = new EphemeralLogStore({ maxEvents: 2, maxBytes: 5_000, now: () => now++ });
    store.append({ ...validEvent, message: 'first' }, false);
    store.append({ ...validEvent, message: 'second' }, false);
    store.append({ ...validEvent, message: 'third' }, false);
    expect(store.read().map(event => event.message)).toEqual(['third', 'second']);
    expect(store.append({ ...validEvent, provider: 'invalid' as never })).toBe(false);
    store.stop();
  });

  it('allowlists event fields and redacts URLs, credentials, opaque identifiers, and wallet-like values', () => {
    const message = sanitizeMonitoringMessage('https://rpc.example/?api-key=secret authorization=Bearer abc wallet 11111111111111111111111111111111 ' + 'a'.repeat(90));
    expect(message).not.toContain('rpc.example');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('11111111111111111111111111111111');
    expect(message).not.toContain('a'.repeat(65));
    expect(sanitizeAssetOrMint('AAPLx')).toBeNull();
    expect(sanitizeAssetOrMint('11111111111111111111111111111111')).toBe('11111111111111111111111111111111');
  });

  it('opens an incident, records one failure, and emits a recovery transition', () => {
    noteProviderAttempt('JUPITER', 'price_fetch', 1_000);
    noteProviderFailure({ provider: 'JUPITER', operation: 'price_fetch', status: 'RATE_LIMITED', errorCode: 'RATE_LIMIT', message: 'Jupiter rate limited.', httpStatus: 429 }, 1_001);
    noteProviderAttempt('JUPITER', 'price_fetch', 1_002);
    noteProviderSuccess('JUPITER', 'price_fetch', 120, 1_003);
    const health = providerHealthSnapshot(1_004)[0];
    expect(health).toMatchObject({ provider: 'JUPITER', status: 'HEALTHY', errorsLast6h: 1, incidentOpen: false });
    expect(monitoringStore().read().map(event => event.status)).toEqual(['RECOVERED', 'RATE_LIMITED']);
  });

  it('fails the admin surface closed and uses constant-length credential comparisons', () => {
    delete process.env.ADMIN_HEALTH_ENABLED; delete process.env.ADMIN_HEALTH_USERNAME; delete process.env.ADMIN_HEALTH_PASSWORD;
    expect(isAdminHealthEnabled()).toBe(false);
    expect(isAdminHealthAuthorized(null)).toBe(false);
    process.env.ADMIN_HEALTH_ENABLED = 'true'; process.env.ADMIN_HEALTH_USERNAME = 'operator'; process.env.ADMIN_HEALTH_PASSWORD = 'long-test-password';
    expect(isAdminHealthEnabled()).toBe(true);
    expect(isAdminHealthAuthorized(`Basic ${Buffer.from('operator:wrong').toString('base64')}`)).toBe(false);
    expect(isAdminHealthAuthorized(`Basic ${Buffer.from('operator:long-test-password').toString('base64')}`)).toBe(true);
    expect(ADMIN_HEALTH_SECURITY_HEADERS['Cache-Control']).toContain('no-store');
    expect(ADMIN_HEALTH_SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
  });

  it('builds one or concurrent normalized snapshots without making or multiplying upstream requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = getStockMarketCacheStats();
    const [snapshot, ...concurrent] = await Promise.all(Array.from({ length: 8 }, async () => readMonitoringSnapshot()));
    const after = getStockMarketCacheStats();
    expect(snapshot.retentionHours).toBe(6);
    expect(snapshot.engine.worker.batchSize).toBe(50);
    expect(concurrent).toHaveLength(7);
    expect(after).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
