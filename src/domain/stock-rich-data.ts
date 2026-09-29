import { z } from 'zod';
import { MarketMintSchema, MarketTimestampSchema, MarketNonnegativeDecimalSchema } from './market-types';

const amount = z.number().finite().nonnegative().nullable();
const stamp = { retrievedAt: MarketTimestampSchema, sourceUrl: z.url().startsWith('https://') };
export const StockRichDataSchema = z.object({
  mint: MarketMintSchema,
  dex: z.object({ ...stamp, pair: MarketMintSchema, priceUsd: z.number().finite().positive().nullable(),
    liquidity: amount, volume24h: amount, change24h: z.number().finite().nullable(),
    marketCap: amount, fdv: amount, buys: z.number().int().nonnegative().nullable(),
    sells: z.number().int().nonnegative().nullable(), pairCreatedAt: MarketTimestampSchema.nullable(),
  }).strict().nullable().default(null),
  reserve: z.object({ ...stamp, observedAt: MarketTimestampSchema.nullable(),
    circulating: MarketNonnegativeDecimalSchema.nullable(), shares: MarketNonnegativeDecimalSchema.nullable(),
    custodians: z.array(z.string().max(100)).max(100),
  }).strict().nullable().default(null),
  quote: z.object({ ...stamp, priceUsd: z.number().finite().positive() }).strict().nullable().default(null),
  holders: z.object({ ...stamp, count: z.number().int().nonnegative(), observedAt: MarketTimestampSchema.nullable(),
    totalSupply: MarketNonnegativeDecimalSchema.nullable(),
  }).strict().nullable().default(null),
  listed: z.object({ ...stamp, symbol: z.string().min(1).max(40), currency: z.string().regex(/^[A-Z]{3}$/),
    exchange: z.string().max(80), kind: z.enum(['equity','etf','unknown']),
    price: z.number().finite().positive().nullable(), observedAt: MarketTimestampSchema.nullable(),
    session: z.object({startsAt:MarketTimestampSchema,endsAt:MarketTimestampSchema}).strict().nullable().default(null),
    change: z.number().finite().nullable(), volume: amount,
    closes: z.array(z.object({ at: MarketTimestampSchema, value: z.number().finite().positive() }).strict()).max(5),
  }).strict().nullable().default(null),
}).strict();
export type StockRichData = z.infer<typeof StockRichDataSchema>;
export type RichKind = Exclude<keyof StockRichData, 'mint'>;
export const richMaxAge: Record<RichKind, number> = { dex: 30 * 60_000, reserve: 48 * 3600_000,
  quote: 24 * 3600_000, holders: 48 * 3600_000, listed: 24 * 3600_000 };
export function ageRichData(value: StockRichData | undefined | null, now = Date.now()): StockRichData | null {
  if (!value) return null;
  const result = { ...value };
  for (const kind of Object.keys(richMaxAge) as RichKind[]) {
    const field = result[kind];
    if (field && (now - Date.parse(field.retrievedAt) > richMaxAge[kind]
      || Date.parse(field.retrievedAt) > now + 5000)) result[kind] = null;
  }
  return result;
}

/** Only a source-reported exact-base-token cap/FDV is displayed. Never multiply
 * an underlying quote by issuer-wide or prescaled supply to invent Solana cap. */
export function flowPercent(data: StockRichData | null | undefined) {
  const d = data?.dex;
  return d?.buys != null && d.sells != null && d.buys + d.sells > 0
    ? 100 * d.buys / (d.buys + d.sells) : null;
}

/** Provider exchange timestamps already account for holidays/time zones. Never
 * substitute the token issuer's 24/5 trading flag for a listed exchange session. */
export function listedSession(data:StockRichData['listed']|undefined,now:number) {
  const session=data?.session;
  if(!session)return {status:'unknown' as const,until:null};
  const start=Date.parse(session.startsAt),end=Date.parse(session.endsAt);
  if(end<=start||end-start>86400_000||now-Date.parse(data.retrievedAt)>86400_000||now>end+12*3600_000)return {status:'unknown' as const,until:null};
  return {status:now>=start&&now<end?'open' as const:'closed' as const,
    until:new Date(now<start?start:now<end?end:end+12*3600_000).toISOString()};
}
