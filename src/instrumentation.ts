export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { recordMarketEvent } = await import('@/services/monitoring/log-manager');
  recordMarketEvent({ severity: 'INFO', provider: 'SYSTEM', operation: 'engine_startup', status: 'STARTED', message: 'Market monitoring initialized with six-hour in-memory retention.' }, false);
  // Vercel is always a reader, including an accidentally enabled writer flag.
  if (process.env.VERCEL !== '1' && process.env.MARKET_V2_WRITER_ENABLED === 'true' && !process.env.MARKET_V2_WRITER_ORIGIN) {
    const { startProcessMarketV2Engine } = await import('@/services/market-v2-engine');
    startProcessMarketV2Engine();
  }
}
