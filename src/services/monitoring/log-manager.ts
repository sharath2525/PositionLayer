import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  MonitoringEventSchema,
  type MonitoringEvent,
  type MonitoringErrorCode,
  type MonitoringOperation,
  type MonitoringProvider,
  type MonitoringSeverity,
  type MonitoringStatus,
} from '@/domain/monitoring';
import { eventDedupeKey, sanitizeAssetOrMint, sanitizeFallback, sanitizeMonitoringMessage } from './sanitize';

export const MONITORING_TTL_MS = 6 * 60 * 60 * 1_000;
export const MONITORING_SAFETY_CLEANUP_MS = 15 * 60 * 1_000;
export const MONITORING_MAX_EVENTS = 5_000;
export const MONITORING_MAX_BYTES = 5 * 1_024 * 1_024;
const DEDUPE_WINDOW_MS = 10 * 60 * 1_000;

export type MonitoringEventInput = {
  severity: MonitoringSeverity;
  provider: MonitoringProvider;
  assetOrMint?: string | null;
  operation: MonitoringOperation;
  status: MonitoringStatus;
  latencyMs?: number | null;
  httpStatus?: number | null;
  errorCode?: MonitoringErrorCode;
  message: unknown;
  retryAttempt?: number | null;
  fallbackUsed?: string | null;
  timestamp?: string;
};

type StoredEvent = { event: MonitoringEvent; bytes: number };

export class EphemeralLogStore {
  private events: StoredEvent[] = [];
  private approximateBytes = 0;
  private nextExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly safetyTimer: ReturnType<typeof setInterval>;
  private readonly dedupe = new Map<string, number>();

  constructor(
    private readonly options: { ttlMs?: number; maxEvents?: number; maxBytes?: number; now?: () => number } = {},
  ) {
    this.safetyTimer = setInterval(() => this.prune(), MONITORING_SAFETY_CLEANUP_MS);
    this.safetyTimer.unref?.();
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private ttlMs() { return this.options.ttlMs ?? MONITORING_TTL_MS; }
  private maxEvents() { return this.options.maxEvents ?? MONITORING_MAX_EVENTS; }
  private maxBytes() { return this.options.maxBytes ?? MONITORING_MAX_BYTES; }

  append(input: MonitoringEventInput, deduplicate = true): boolean {
    try {
      const timestamp = input.timestamp ?? new Date(this.now()).toISOString();
      const event = MonitoringEventSchema.parse({
        id: randomUUID(), timestamp, severity: input.severity, provider: input.provider,
        assetOrMint: sanitizeAssetOrMint(input.assetOrMint), operation: input.operation, status: input.status,
        latencyMs: input.latencyMs == null ? null : Math.max(0, Math.round(input.latencyMs)),
        httpStatus: input.httpStatus ?? null, errorCode: input.errorCode ?? null,
        message: sanitizeMonitoringMessage(input.message), retryAttempt: input.retryAttempt ?? null,
        fallbackUsed: sanitizeFallback(input.fallbackUsed),
      });
      const now = this.now();
      this.prune(now);
      if (Date.parse(event.timestamp) < now - this.ttlMs()) return false;
      const key = eventDedupeKey(event);
      const previous = this.dedupe.get(key);
      if (deduplicate && previous !== undefined && now - previous < DEDUPE_WINDOW_MS) return false;
      this.dedupe.set(key, now);
      const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      this.events.push({ event, bytes });
      this.approximateBytes += bytes;
      while (this.events.length > this.maxEvents() || this.approximateBytes > this.maxBytes()) this.removeOldest();
      this.scheduleNextExpiry(now);
      return true;
    } catch {
      return false;
    }
  }

  read(limit = 100, now = this.now()): MonitoringEvent[] {
    this.prune(now);
    return this.events.slice(-Math.max(0, Math.min(100, limit))).reverse().map(row => row.event);
  }

  stats(now = this.now()) {
    this.prune(now);
    return { eventCount: this.events.length, approximateBytes: this.approximateBytes, maxEvents: this.maxEvents(), maxBytes: this.maxBytes() };
  }

  prune(now = this.now()) {
    const cutoff = now - this.ttlMs();
    const retained = this.events.filter(row => Date.parse(row.event.timestamp) >= cutoff);
    if (retained.length !== this.events.length) {
      this.events = retained;
      this.approximateBytes = retained.reduce((sum, row) => sum + row.bytes, 0);
    }
    for (const [key, timestamp] of this.dedupe) if (timestamp < cutoff) this.dedupe.delete(key);
    this.scheduleNextExpiry(now);
  }

  clear() {
    this.events = [];
    this.approximateBytes = 0;
    this.dedupe.clear();
    if (this.nextExpiryTimer) clearTimeout(this.nextExpiryTimer);
    this.nextExpiryTimer = null;
  }

  stop() {
    this.clear();
    clearInterval(this.safetyTimer);
  }

  private removeOldest() {
    const oldest = this.events.shift();
    if (oldest) this.approximateBytes = Math.max(0, this.approximateBytes - oldest.bytes);
  }

  private scheduleNextExpiry(now: number) {
    if (this.nextExpiryTimer) clearTimeout(this.nextExpiryTimer);
    this.nextExpiryTimer = null;
    const oldestTimestamp = this.events.reduce<number | null>((oldest, row) => {
      const timestamp = Date.parse(row.event.timestamp);
      return oldest === null || timestamp < oldest ? timestamp : oldest;
    }, null);
    if (oldestTimestamp === null) return;
    const expiresAfter = oldestTimestamp + this.ttlMs() - now + 1;
    this.nextExpiryTimer = setTimeout(() => this.prune(), Math.max(1, expiresAfter));
    this.nextExpiryTimer.unref?.();
  }
}

type MonitoringRoot = { version: string; store: EphemeralLogStore };
const root = globalThis as typeof globalThis & { positionLayerMonitoring?: MonitoringRoot };
if (root.positionLayerMonitoring?.version !== 'six-hour-observability-v1') {
  root.positionLayerMonitoring?.store.stop();
  root.positionLayerMonitoring = { version: 'six-hour-observability-v1', store: new EphemeralLogStore() };
}

export function isMarketMonitoringEnabled() { return process.env.MARKET_MONITORING_ENABLED !== 'false'; }
export function monitoringStore() { return root.positionLayerMonitoring!.store; }
export function recordMarketEvent(input: MonitoringEventInput, deduplicate = true) {
  if (!isMarketMonitoringEnabled()) return false;
  return monitoringStore().append(input, deduplicate);
}
