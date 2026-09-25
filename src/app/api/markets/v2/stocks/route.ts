import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CanonicalMarketQuerySchema } from '@/domain/market-api-v2';
import { readCanonicalMarketPage } from '@/services/market-v2-reader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowed = new Set(['search', 'type', 'verification', 'price', 'sort', 'direction', 'page', 'pageSize']);

export async function GET(request: Request) {
  if (request.headers.get('X-PositionLayer-Market-Hop') && process.env.MARKET_V2_WRITER_ORIGIN) {
    return NextResponse.json({ status: 'error', message: 'Canonical market reader cannot proxy another reader.' },
      { status: 508, headers: { 'Cache-Control': 'no-store' } });
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return NextResponse.json({ status: 'error', message: 'Invalid canonical market query.' }, { status: 400 });
  }
  try {
    const query = CanonicalMarketQuerySchema.parse(Object.fromEntries(params));
    const page = await readCanonicalMarketPage(query);
    return NextResponse.json(page, { headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=30',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ status: 'error', message: 'Invalid canonical market query.' }, { status: 400 });
    return NextResponse.json({ status: 'error', message: 'Canonical market data is temporarily unavailable.' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}
