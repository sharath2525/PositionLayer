import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readOfflineStockMarketDetail, readStockMarketDetail } from '@/services/stocks-market';
import { marketV2WriterOrigin, readRemoteLegacyDetail } from '@/services/market-v2-remote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MintSchema = z.string().min(32).max(64).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export async function GET(request: Request, context: { params: Promise<{ mint: string }> }) {
  if (request.headers.get('X-PositionLayer-Market-Hop') && process.env.MARKET_V2_WRITER_ORIGIN) {
    return NextResponse.json({ status: 'error', message: 'Market reader cannot proxy another reader.' },
      { status: 508, headers: { 'Cache-Control': 'no-store' } });
  }
  const { mint: rawMint } = await context.params;
  const parsed = MintSchema.safeParse(rawMint);
  if (!parsed.success) return NextResponse.json({ status: 'error', message: 'Invalid stock mint.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  try {
    const writerOrigin = marketV2WriterOrigin();
    if (writerOrigin) {
      let detail;
      try { detail = await readRemoteLegacyDetail(writerOrigin, parsed.data); }
      catch { detail = readOfflineStockMarketDetail(parsed.data); }
      if (!detail) return NextResponse.json({ status: 'error', message: 'Stock mint not found in reviewed fallback.' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return NextResponse.json(detail, { headers: {
        'Cache-Control': detail.status === 'stale' ? 'no-store'
          : 'public, max-age=0, s-maxage=15, stale-while-revalidate=30',
        'X-Content-Type-Options': 'nosniff',
      } });
    }
    const detail = await readStockMarketDetail(parsed.data);
    if (!detail) return NextResponse.json({ status: 'error', message: 'Stock mint not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(detail, { headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=60',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return NextResponse.json({ status: 'error', message: 'Stock intelligence is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
