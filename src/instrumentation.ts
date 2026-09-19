export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordMarketEvent } = await import('@/services/monitoring/log-manager');
  recordMarketEvent({ severity: 'INFO', provider: 'SYSTEM', operation: 'engine_startup', status: 'STARTED', message: 'Market monitoring initialized with six-hour in-memory retention.' }, false);
}
