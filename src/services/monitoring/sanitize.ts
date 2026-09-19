import type { MonitoringEvent } from '@/domain/monitoring';

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_PATTERN = /\b(?:authorization|api[-_ ]?key|token|secret|password|cookie|bearer)\b\s*[:=]?\s*[^\s,;]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BASE58_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,64}\b/g;
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9+/_-]{65,}={0,2}\b/g;

export function sanitizeMonitoringMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : 'Provider operation failed.';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(URL_PATTERN, '[url redacted]')
    .replace(CREDENTIAL_PATTERN, '[credential redacted]')
    .replace(JWT_PATTERN, '[credential redacted]')
    .replace(BASE58_PATTERN, '[public identifier redacted]')
    .replace(LONG_OPAQUE_PATTERN, '[opaque value redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 256) || 'Provider operation failed.';
}

export function sanitizeFallback(value: string | null | undefined): string | null {
  if (!value) return null;
  return sanitizeMonitoringMessage(value).slice(0, 64);
}

export function sanitizeAssetOrMint(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(value) ? value : null;
}

export function eventDedupeKey(event: Pick<MonitoringEvent, 'provider' | 'operation' | 'assetOrMint' | 'status' | 'errorCode'>) {
  return [event.provider, event.operation, event.assetOrMint || '-', event.status, event.errorCode || '-'].join('|');
}
