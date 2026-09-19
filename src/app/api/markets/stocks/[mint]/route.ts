import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readStockMarketDetail } from '@/services/stocks-market';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MintSchema = z.string().min(32).max(64).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export async function GET(_request: Request, context: { params: Promise<{ mint: string }> }) {
  const { mint: rawMint } = await context.params;
  const parsed = MintSchema.safeParse(rawMint);
  if (!parsed.success) return NextResponse.json({ status: 'error', message: 'Invalid stock mint.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  try {
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
