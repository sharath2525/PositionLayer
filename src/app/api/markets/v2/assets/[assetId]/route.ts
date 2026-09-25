import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readCanonicalMarketDetail } from '@/services/market-v2-reader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AssetIdSchema = z.string().min(1).max(160).regex(/^(isin:[A-Z0-9:]+|solana:[1-9A-HJ-NP-Za-km-z]{32,44})$/);

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  if (request.headers.get('X-PositionLayer-Market-Hop') && process.env.MARKET_V2_WRITER_ORIGIN) {
    return NextResponse.json({ status: 'error', message: 'Canonical market reader cannot proxy another reader.' },
      { status: 508, headers: { 'Cache-Control': 'no-store' } });
  }
  const parsed = AssetIdSchema.safeParse((await context.params).assetId);
  if (!parsed.success) return NextResponse.json({ status: 'error', message: 'Invalid canonical asset ID.' },
    { status: 400, headers: { 'Cache-Control': 'no-store' } });
  try {
    const detail = await readCanonicalMarketDetail(parsed.data);
    if (!detail) return NextResponse.json({ status: 'error', message: 'Canonical asset not found.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(detail, { headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=30',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return NextResponse.json({ status: 'error', message: 'Canonical asset data is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
