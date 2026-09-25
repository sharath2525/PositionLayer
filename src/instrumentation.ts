export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordMarketEvent } = await import('@/services/monitoring/log-manager');
  recordMarketEvent({ severity: 'INFO', provider: 'SYSTEM', operation: 'engine_startup', status: 'STARTED', message: 'Market monitoring initialized with six-hour in-memory retention.' }, false);
  // Explicit opt-in for a single persistent Node process. Serverless instances
  // cannot share this memory lease; default and legacy routes stay unchanged.
  if (process.env.MARKET_V2_WRITER_ENABLED === 'true' && !process.env.MARKET_V2_WRITER_ORIGIN) {
    const { startProcessMarketV2Engine } = await import('@/services/market-v2-engine');
    startProcessMarketV2Engine();
  }
}
