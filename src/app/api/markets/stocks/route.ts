import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { StockMarketQuerySchema } from '@/domain/stocks';
import { readOfflineStockMarketPage, readStockMarketPage } from '@/services/stocks-market';
import { marketV2WriterOrigin, readRemoteLegacyPage } from '@/services/market-v2-remote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowed = new Set(['search', 'assetType', 'issuer', 'price', 'sort', 'direction', 'page', 'pageSize']);

export async function GET(request: Request) {
  if (request.headers.get('X-PositionLayer-Market-Hop') && process.env.MARKET_V2_WRITER_ORIGIN) {
    return NextResponse.json({ status: 'error', message: 'Market reader cannot proxy another reader.' },
      { status: 508, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(request.url);
  const unknown = [...url.searchParams.keys()].filter(key => !allowed.has(key));
  const duplicates = [...allowed].filter(key => url.searchParams.getAll(key).length > 1);
  if (unknown.length || duplicates.length) return NextResponse.json({ status: 'error', message: 'Invalid market query.' }, { status: 400 });
  try {
    const query = StockMarketQuerySchema.parse(Object.fromEntries(url.searchParams));
    const writerOrigin = marketV2WriterOrigin();
    if (writerOrigin) {
      let page;
      try { page = await readRemoteLegacyPage(writerOrigin, query); }
      catch { page = readOfflineStockMarketPage(query); }
      return NextResponse.json(page, { headers: {
        'Cache-Control': page.status === 'stale' ? 'no-store'
          : 'public, max-age=0, s-maxage=15, stale-while-revalidate=30',
        'X-Content-Type-Options': 'nosniff',
      } });
    }
    const result = await readStockMarketPage(query, request.signal);
    const headers = new Headers({
      'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=60',
      'X-Content-Type-Options': 'nosniff',
    });
    if (result.retryAfterSeconds !== null) headers.set('Retry-After', String(result.retryAfterSeconds));
    return NextResponse.json(result.page, { headers });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ status: 'error', message: 'Invalid market query.' }, { status: 400 });
    return NextResponse.json({ status: 'error', message: 'Public stock market data is temporarily unavailable.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}
