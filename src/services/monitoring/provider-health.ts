import 'server-only';
import type { ProviderHealthSchema } from '@/domain/monitoring';
import type { z } from 'zod';
import type { MonitoringErrorCode, MonitoringOperation, MonitoringProvider, MonitoringStatus } from '@/domain/monitoring';
import { recordMarketEvent } from './log-manager';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';
type OperationState = {
  provider: MonitoringProvider; operation: MonitoringOperation; lastSuccessAt: number | null; lastFailureAt: number | null;
  latencyMs: number | null; attempts: number[]; failures: number[]; consecutiveFailures: number; incidentOpen: boolean;
};
type HealthRoot = { version: string; operations: Map<string, OperationState> };
const root = globalThis as typeof globalThis & { positionLayerProviderHealth?: HealthRoot };
if (root.positionLayerProviderHealth?.version !== 'six-hour-observability-v1') {
  root.positionLayerProviderHealth = { version: 'six-hour-observability-v1', operations: new Map() };
}
const state = root.positionLayerProviderHealth;

function key(provider: MonitoringProvider, operation: MonitoringOperation) { return `${provider}:${operation}`; }
function getState(provider: MonitoringProvider, operation: MonitoringOperation): OperationState {
  const id = key(provider, operation);
  let value = state.operations.get(id);
  if (!value) {
    value = { provider, operation, lastSuccessAt: null, lastFailureAt: null, latencyMs: null, attempts: [], failures: [], consecutiveFailures: 0, incidentOpen: false };
    state.operations.set(id, value);
  }
  return value;
}
function prune(row: OperationState, now: number) {
  const cutoff = now - SIX_HOURS_MS;
  row.attempts = row.attempts.filter(value => value >= cutoff).slice(-5_000);
  row.failures = row.failures.filter(value => value >= cutoff).slice(-5_000);
}
function status(row: OperationState): HealthStatus {
  if (row.lastSuccessAt === null && row.lastFailureAt === null) return 'UNKNOWN';
  if (!row.incidentOpen) return 'HEALTHY';
  return row.consecutiveFailures >= 3 ? 'UNAVAILABLE' : 'DEGRADED';
}

export function noteProviderAttempt(provider: MonitoringProvider, operation: MonitoringOperation, now = Date.now()) {
  const row = getState(provider, operation); prune(row, now); row.attempts.push(now);
  if (row.attempts.length > 5_000) row.attempts.shift();
}

export function noteProviderSuccess(provider: MonitoringProvider, operation: MonitoringOperation, latencyMs: number, now = Date.now()) {
  const row = getState(provider, operation); prune(row, now);
  row.lastSuccessAt = now;
  row.latencyMs = row.latencyMs === null ? Math.round(latencyMs) : Math.round(row.latencyMs * 0.7 + latencyMs * 0.3);
  const recovered = row.incidentOpen;
  row.consecutiveFailures = 0; row.incidentOpen = false;
  if (recovered) recordMarketEvent({ severity: 'INFO', provider, operation, status: 'RECOVERED', latencyMs, message: `${provider} ${operation} recovered.` }, false);
  if (latencyMs >= 5_000) recordMarketEvent({ severity: 'WARN', provider, operation, status: 'SLOW_RESPONSE', errorCode: 'SLOW_PROVIDER', latencyMs, message: `${provider} ${operation} exceeded the five-second latency threshold.` });
}

export function noteProviderFailure(input: {
  provider: MonitoringProvider; operation: MonitoringOperation; status: MonitoringStatus; errorCode: MonitoringErrorCode;
  message: unknown; latencyMs?: number | null; httpStatus?: number | null; retryAttempt?: number | null; fallbackUsed?: string | null;
}, now = Date.now()) {
  const row = getState(input.provider, input.operation); prune(row, now);
  row.lastFailureAt = now; row.failures.push(now); row.consecutiveFailures++; row.incidentOpen = true;
  if (row.failures.length > 5_000) row.failures.shift();
  if (input.latencyMs !== null && input.latencyMs !== undefined) row.latencyMs = Math.round(input.latencyMs);
  recordMarketEvent({ severity: row.consecutiveFailures >= 3 ? 'ERROR' : 'WARN', ...input });
}

export function noteRetry(input: { provider: MonitoringProvider; operation: MonitoringOperation; retryAttempt: number; delayMs: number }) {
  recordMarketEvent({ severity: 'WARN', provider: input.provider, operation: input.operation, status: 'RETRY_SCHEDULED', errorCode: 'RATE_LIMIT', retryAttempt: input.retryAttempt, message: `Retry scheduled in ${Math.ceil(input.delayMs / 1_000)} seconds.` }, false);
}

export function providerHealthSnapshot(now = Date.now()): z.infer<typeof ProviderHealthSchema>[] {
  const groups = new Map<MonitoringProvider, OperationState[]>();
  for (const row of state.operations.values()) {
    prune(row, now);
    const current = groups.get(row.provider) || []; current.push(row); groups.set(row.provider, current);
  }
  const rank: Record<HealthStatus, number> = { UNKNOWN: 0, HEALTHY: 1, DEGRADED: 2, UNAVAILABLE: 3 };
  return [...groups.entries()].map(([provider, rows]) => {
    const operations = rows.map(row => ({
      operation: row.operation, status: status(row), lastSuccessAt: row.lastSuccessAt === null ? null : new Date(row.lastSuccessAt).toISOString(),
      lastFailureAt: row.lastFailureAt === null ? null : new Date(row.lastFailureAt).toISOString(), latencyMs: row.latencyMs,
      attemptsLast6h: row.attempts.length, errorsLast6h: row.failures.length, incidentOpen: row.incidentOpen,
    })).sort((a, b) => a.operation.localeCompare(b.operation));
    const overall = operations.reduce<HealthStatus>((worst, row) => rank[row.status] > rank[worst] ? row.status : worst, 'UNKNOWN');
    const successes = rows.map(row => row.lastSuccessAt).filter((value): value is number => value !== null);
    const failures = rows.map(row => row.lastFailureAt).filter((value): value is number => value !== null);
    const latencies = rows.map(row => row.latencyMs).filter((value): value is number => value !== null);
    return { provider, status: overall, lastSuccessAt: successes.length ? new Date(Math.max(...successes)).toISOString() : null,
      lastFailureAt: failures.length ? new Date(Math.max(...failures)).toISOString() : null,
      latencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      attemptsLast6h: operations.reduce((sum, row) => sum + row.attemptsLast6h, 0), errorsLast6h: operations.reduce((sum, row) => sum + row.errorsLast6h, 0),
      incidentOpen: operations.some(row => row.incidentOpen), operations };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function resetProviderHealthForTests() { state.operations.clear(); }
