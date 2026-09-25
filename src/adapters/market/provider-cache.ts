import 'server-only';
import type { MonitoringOperation, MonitoringProvider } from '@/domain/monitoring';
import { recordMarketEvent } from '@/services/monitoring/log-manager';
import {
  ProviderReadResultSchema, type ProviderCandidate, type ProviderIssue,
  type ProviderReadResult,
} from '@/domain/market-provider';

export class MarketProviderError extends Error {
  constructor(
    public readonly issue: ProviderIssue,
    public readonly httpStatus: number | null = null,
    public readonly retryAfter: number | null = null,
  ) { super(issue); this.name = 'MarketProviderError'; }
}

export type ProviderLoad = {
  records: ProviderCandidate[];
  complete: boolean;
  issues: ProviderIssue[];
  retryAfter?: number | null;
};

const stamp = (milliseconds: number) => new Date(milliseconds).toISOString();
const uniqueIssues = (issues: ProviderIssue[]) => [...new Set(issues)].slice(0, 12);

/** Lazy, process-local cache. No timer or provider request is started on import. */
export class MarketProviderCache {
  private complete: { records: ProviderCandidate[]; at: number } | null = null;
  private inFlight: Promise<ProviderReadResult> | null = null;
  private lastAttempt: number | null = null;
  private nextAttempt = 0;
  private failures = 0;
  private incidentOpen = false;

  constructor(private readonly options: {
    provider: ProviderReadResult['provider'];
    monitoringProvider: MonitoringProvider;
    operation: MonitoringOperation;
    ttlMs: number;
    staleMs: number;
    now?: () => number;
  }) {}

  private now() { return this.options.now?.() ?? Date.now(); }
  private result(status: ProviderReadResult['status'], records: ProviderCandidate[], issues: ProviderIssue[], retryAfter: number | null) {
    return ProviderReadResultSchema.parse({
      provider: this.options.provider, status, records,
      lastSuccess: this.complete ? stamp(this.complete.at) : null,
      lastAttempt: this.lastAttempt === null ? null : stamp(this.lastAttempt),
      retryAfter, issues: uniqueIssues(issues),
    });
  }
  private eligiblePrevious(now: number) {
    return this.complete && now - this.complete.at <= this.options.ttlMs + this.options.staleMs
      ? this.complete.records : null;
  }
  private logFailure(issue: ProviderIssue, fallback: boolean) {
    if (this.incidentOpen) return;
    this.incidentOpen = true;
    const mapped = issue === 'RATE_LIMIT' ? ['RATE_LIMITED', 'RATE_LIMIT'] as const
      : issue === 'TIMEOUT' ? ['TIMEOUT', 'TIMEOUT'] as const
      : issue === 'INVALID_RESPONSE' || issue === 'INVALID_RECORD' ? ['SCHEMA_VALIDATION_FAILED', 'SCHEMA'] as const
      : issue === 'INVALID_JSON' ? ['INVALID_JSON', 'INVALID_JSON'] as const
      : issue === 'PAGE_MISMATCH' || issue === 'PAGE_LIMIT' || issue === 'PARTIAL_PAGE'
        ? ['NORMALIZATION_FAILED', 'NORMALIZATION'] as const
      : issue === 'HTTP_CLIENT' ? ['HTTP_4XX', 'HTTP_CLIENT'] as const
      : issue === 'HTTP_SERVER' ? ['HTTP_5XX', 'HTTP_SERVER'] as const
      : ['NETWORK_ERROR', 'NETWORK'] as const;
    recordMarketEvent({
      severity: fallback ? 'WARN' : 'ERROR', provider: this.options.monitoringProvider,
      operation: this.options.operation, status: mapped[0], errorCode: mapped[1],
      message: 'Optional market provider refresh failed; available validated data was retained where eligible.',
      fallbackUsed: fallback ? 'bounded-stale-cache' : null,
    });
  }
  private logRecovery() {
    if (!this.incidentOpen) return;
    this.incidentOpen = false;
    recordMarketEvent({
      severity: 'INFO', provider: this.options.monitoringProvider,
      operation: this.options.operation, status: 'RECOVERED', errorCode: null,
      message: 'Optional market provider returned a complete validated response.',
    });
  }

  async read(loader: () => Promise<ProviderLoad>): Promise<ProviderReadResult> {
    const now = this.now();
    if (this.complete && now - this.complete.at < this.options.ttlMs) {
      return this.result('ready', this.complete.records, [], null);
    }
    if (this.inFlight) return this.inFlight;
    if (now < this.nextAttempt) {
      const previous = this.eligiblePrevious(now);
      return this.result(previous ? 'stale' : 'rate-limited', previous ?? [],
        previous ? ['COOLDOWN', 'RETAINED_LAST_GOOD'] : ['COOLDOWN'],
        Math.ceil((this.nextAttempt - now) / 1000));
    }
    this.lastAttempt = now;
    this.inFlight = this.refresh(loader);
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }

  private async refresh(loader: () => Promise<ProviderLoad>): Promise<ProviderReadResult> {
    try {
      const loaded = await loader();
      // Parse before publication: no partial or malformed value replaces last good.
      const checked = ProviderReadResultSchema.parse({
        provider: this.options.provider, status: loaded.complete ? 'ready' : 'partial',
        records: loaded.records, lastSuccess: this.complete ? stamp(this.complete.at) : null,
        lastAttempt: stamp(this.lastAttempt!), retryAfter: loaded.retryAfter ?? null,
        issues: uniqueIssues(loaded.issues),
      });
      if (loaded.complete) {
        this.complete = { records: checked.records, at: this.now() };
        this.failures = 0;
        this.nextAttempt = 0;
        this.logRecovery();
        return this.result('ready', checked.records, checked.issues, null);
      }
      return this.onFailure(checked.issues[0] ?? 'PARTIAL_PAGE', checked.records, checked.issues,
        checked.retryAfter);
    } catch (error) {
      const failure = error instanceof MarketProviderError ? error : new MarketProviderError('INVALID_RESPONSE');
      return this.onFailure(failure.issue, [], [failure.issue], failure.retryAfter);
    }
  }

  private onFailure(issue: ProviderIssue, partial: ProviderCandidate[], issues: ProviderIssue[], retryAfter: number | null) {
    this.failures++;
    const now = this.now();
    const clientOrSchema = ['HTTP_CLIENT', 'INVALID_JSON', 'INVALID_RESPONSE', 'INVALID_RECORD', 'PAGE_MISMATCH'].includes(issue);
    const cooldownMs = clientOrSchema ? 10 * 60_000
      : Math.max((retryAfter ?? 0) * 1000, Math.min(5 * 60_000, 30_000 * 2 ** Math.min(4, this.failures - 1)));
    this.nextAttempt = now + cooldownMs;
    const previous = this.eligiblePrevious(now);
    this.logFailure(issue, previous !== null);
    if (previous) return this.result('stale', previous, [...issues, 'RETAINED_LAST_GOOD'], Math.ceil(cooldownMs / 1000));
    if (partial.length) return this.result('partial', partial, issues, Math.ceil(cooldownMs / 1000));
    return this.result(issue === 'RATE_LIMIT' ? 'rate-limited' : 'unavailable', [], issues, Math.ceil(cooldownMs / 1000));
  }

  /** Test-only reset; no production path calls this. */
  reset() {
    this.complete = null; this.inFlight = null; this.lastAttempt = null;
    this.nextAttempt = 0; this.failures = 0; this.incidentOpen = false;
  }
}
