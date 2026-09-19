import 'server-only';
import type { MonitoringErrorCode, MonitoringOperation, MonitoringProvider, MonitoringStatus } from '@/domain/monitoring';
import { sanitizeMonitoringMessage } from './sanitize';
import { noteProviderAttempt, noteProviderFailure, noteProviderSuccess } from './provider-health';

export type ProviderOperation = { provider: MonitoringProvider; operation: MonitoringOperation; fallbackUsed?: string | null };

export function classifyProviderError(error: unknown): { status: MonitoringStatus; errorCode: MonitoringErrorCode; httpStatus: number | null; message: string; ignored: boolean } {
  const value = error as { name?: unknown; kind?: unknown; status?: unknown; message?: unknown };
  const message = sanitizeMonitoringMessage(error);
  if (value?.kind === 'aborted' || value?.name === 'AbortError') return { status: 'NETWORK_ERROR', errorCode: 'NETWORK', httpStatus: null, message: 'Provider request was cancelled.', ignored: true };
  if (value?.kind === 'timeout' || /timed? ?out|timeout/i.test(message)) return { status: 'TIMEOUT', errorCode: 'TIMEOUT', httpStatus: null, message, ignored: false };
  if (value?.kind === 'rate-limited' || value?.status === 429) return { status: /queue/i.test(message) ? 'QUEUE_FULL' : 'RATE_LIMITED', errorCode: /queue/i.test(message) ? 'QUEUE_FULL' : 'RATE_LIMIT', httpStatus: 429, message, ignored: false };
  if (value?.kind === 'malformed' || /schema|validation/i.test(message)) return { status: 'SCHEMA_VALIDATION_FAILED', errorCode: 'SCHEMA', httpStatus: typeof value?.status === 'number' ? value.status : null, message, ignored: false };
  if (/json/i.test(message)) return { status: 'INVALID_JSON', errorCode: 'INVALID_JSON', httpStatus: typeof value?.status === 'number' ? value.status : null, message, ignored: false };
  const httpStatus = typeof value?.status === 'number' ? value.status : Number(message.match(/HTTP\s+(\d{3})/i)?.[1]) || null;
  if (httpStatus !== null) return { status: httpStatus >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', errorCode: httpStatus >= 500 ? 'HTTP_SERVER' : 'HTTP_CLIENT', httpStatus, message, ignored: false };
  return { status: 'NETWORK_ERROR', errorCode: 'NETWORK', httpStatus: null, message, ignored: false };
}

export async function observeProviderCall<T>(metadata: ProviderOperation, callback: () => Promise<T>): Promise<T> {
  const started = performance.now();
  noteProviderAttempt(metadata.provider, metadata.operation);
  try {
    const result = await callback();
    noteProviderSuccess(metadata.provider, metadata.operation, performance.now() - started);
    return result;
  } catch (error) {
    const classified = classifyProviderError(error);
    if (!classified.ignored) noteProviderFailure({ ...metadata, ...classified, latencyMs: performance.now() - started });
    throw error;
  }
}
