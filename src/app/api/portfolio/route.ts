import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { liveProvider } from '@/services/live';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
const Body = z.object({ owner: z.string().min(32).max(44), selection: z.object({ vaultId: z.number().int().positive().max(65535), positionId: z.number().int().positive().max(4294967295) }).optional() }).strict();
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ status: 'error', code: 'INVALID_INPUT', message: 'Provide a valid JSON request.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ status: 'error', code: 'INVALID_INPUT', message: 'Provide a valid public wallet and complete position selection.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  try { new PublicKey(parsed.data.owner); } catch { return NextResponse.json({ status: 'error', code: 'INVALID_WALLET', message: 'Invalid Solana address.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const result = await liveProvider.read(parsed.data.owner, request.signal, parsed.data.selection);
  return NextResponse.json(result, { status: result.status === 'error' ? 502 : 200, headers: { 'Cache-Control': 'private, no-store' } });
}
