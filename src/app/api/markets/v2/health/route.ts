import { NextResponse } from 'next/server';
import { CanonicalMarketQuerySchema } from '@/domain/market-api-v2';
import { readCanonicalMarketPage, readCurrentMarketSnapshot } from '@/services/market-v2-reader';
import { marketV2EngineStatus } from '@/services/market-v2-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (request.headers.get('X-PositionLayer-Market-Hop') && process.env.MARKET_V2_WRITER_ORIGIN) {
    return NextResponse.json({ status: 'proxy-loop' }, { status: 508 });
  }
  try {
    const page = await readCanonicalMarketPage(CanonicalMarketQuerySchema.parse({ pageSize: 1 }));
    const { progress } = await readCurrentMarketSnapshot();
    return NextResponse.json({ status: page.status, source: page.source,
      role: process.env.MARKET_V2_WRITER_ORIGIN || process.env.VERCEL === '1' ? 'reader' : 'local',
      localEngine: marketV2EngineStatus(), catalogId: page.catalog.id,
      snapshotAgeMs: page.prices.completedAt ? Math.max(0, Date.now() - Date.parse(page.prices.completedAt)) : null,
      activeLocalCycle: progress, prices: page.prices, coverage: page.summary, providers: page.providers },
    { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
