'use client';
import { useEffect, useState } from 'react';
import type { MonitoringSnapshot } from '@/domain/monitoring';
import styles from './health.module.css';

function relative(value: string | null, now: number) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function utcTime(value: string) {
  return `${value.slice(11, 19)} UTC`;
}

export function HealthDashboard({ initial }: { initial: MonitoringSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [pollState, setPollState] = useState<'live' | 'paused' | 'error'>('live');
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (document.hidden) { setPollState('paused'); return; }
      try {
        const response = await fetch('/api/admin/health', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw Error('Health snapshot unavailable.');
        const next = await response.json() as MonitoringSnapshot;
        if (active) { setSnapshot(next); setPollState('live'); }
      } catch { if (active) setPollState('error'); }
    };
    const timer = window.setInterval(poll, 15_000);
    const visibility = () => { if (!document.hidden) void poll(); else setPollState('paused'); };
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const now = Date.parse(snapshot.generatedAt);
  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>INTERNAL · READ ONLY</p><h1>Market engine health</h1><p>Temporary operational events automatically expire after six hours.</p></div>
      <div className={`${styles.poll} ${styles[pollState]}`}><span />{pollState === 'live' ? 'Live · 15s' : pollState === 'paused' ? 'Paused while hidden' : 'Snapshot refresh failed'}</div>
    </header>

    <section aria-label="Market engine summary" className={styles.summary}>
      <article><span>Worker</span><strong>{snapshot.engine.worker.status}</strong><small>{snapshot.engine.worker.cached} / {snapshot.engine.worker.target} prices cached</small></article>
      <article><span>Price cycles</span><strong>{snapshot.engine.priceCycles}</strong><small>{snapshot.engine.priceFailures} failed batches</small></article>
      <article><span>Last batch</span><strong>{relative(snapshot.engine.worker.lastBatchAt, now)}</strong><small>Six sequential batches of {snapshot.engine.worker.batchSize}</small></article>
      <article><span>Temporary store</span><strong>{snapshot.store.eventCount}</strong><small>{Math.ceil(snapshot.store.approximateBytes / 1024)} KB · max {snapshot.store.maxEvents} events</small></article>
    </section>

    <section className={styles.section}>
      <div className={styles.sectionTitle}><div><h2>Providers</h2><p>Health is derived from real operations; this page performs no upstream calls.</p></div><span>Last 6 hours</span></div>
      {snapshot.providers.length ? <div className={styles.providers}>{snapshot.providers.map(provider => <article key={provider.provider}>
        <div><h3>{provider.provider.replace('_', ' ')}</h3><span className={`${styles.badge} ${styles[provider.status.toLowerCase()]}`}>{provider.status}</span></div>
        <dl><div><dt>Last success</dt><dd>{relative(provider.lastSuccessAt, now)}</dd></div><div><dt>Latency</dt><dd>{provider.latencyMs === null ? '—' : `${provider.latencyMs} ms`}</dd></div><div><dt>Errors</dt><dd>{provider.errorsLast6h}</dd></div><div><dt>Attempts</dt><dd>{provider.attemptsLast6h}</dd></div></dl>
        <details><summary>{provider.operations.length} operation{provider.operations.length === 1 ? '' : 's'}</summary>{provider.operations.map(operation => <p key={operation.operation}>{operation.operation.replaceAll('_', ' ')} <b>{operation.status}</b></p>)}</details>
      </article>)}</div> : <div className={styles.empty}>No provider operation has run in this server process yet.</div>}
    </section>

    <section className={styles.section}>
      <div className={styles.sectionTitle}><div><h2>Recent events</h2><p>Sanitized incidents, retries, recoveries, and lifecycle events only.</p></div><span>{snapshot.events.length} shown</span></div>
      {snapshot.events.length ? <div className={styles.tableWrap}><table><thead><tr><th>Time</th><th>Level</th><th>Provider</th><th>Operation</th><th>Status</th><th>Latency</th><th>Message</th></tr></thead><tbody>{snapshot.events.map(event => <tr key={event.id}>
        <td>{utcTime(event.timestamp)}</td><td><span className={`${styles.level} ${styles[event.severity.toLowerCase()]}`}>{event.severity}</span></td><td>{event.provider}</td><td>{event.operation.replaceAll('_', ' ')}</td><td>{event.status.replaceAll('_', ' ')}</td><td>{event.latencyMs === null ? '—' : `${event.latencyMs} ms`}</td><td>{event.message}</td>
      </tr>)}</tbody></table></div> : <div className={styles.empty}>No retained incident or lifecycle events.</div>}
    </section>
    <footer className={styles.footer}>No credentials, wallet addresses, request payloads, URLs, headers, or response bodies are retained. Data is process-local and disappears on restart.</footer>
  </main>;
}
