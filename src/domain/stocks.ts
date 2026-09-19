import { z } from 'zod';
import { decimal } from './amounts';
import { MarketEvidenceSchema, MarketObservationSchema } from './market-observations';

const DecimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const TimestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO timestamp');

export const StockIdentityClassSchema = z.enum(['issuer-confirmed-xstock', 'jupiter-stock-tagged']);
export const StockAssetTypeSchema = z.enum(['equity', 'etf', 'unknown']);
export const PremiumDiscountReasonSchema = z.enum([
  'no-jupiter-price',
  'no-issuer-price',
  'stale-jupiter-price',
  'unit-mismatch',
  'currency-mismatch',
  'pending-multiplier',
  'trading-halted',
  'issuer-unverified',
]);
export const StockMarketStatusSchema = z.object({
  period: z.enum(['market', 'extended', 'overnight', 'closed']).nullable(),
  openNow: z.boolean().nullable(),
  tradingHalted: z.boolean().nullable(),
  currency: z.string().nullable(),
  nextChangeAt: TimestampSchema.nullable(),
}).strict();
export const StockMultiplierSchema = z.object({
  status: z.enum(['current', 'pending', 'unavailable']),
  current: DecimalStringSchema.nullable(),
  pending: DecimalStringSchema.nullable(),
  activationAt: TimestampSchema.nullable(),
  reason: z.string().nullable(),
}).strict();
export const StockPremiumDiscountSchema = z.object({
  status: z.enum(['available', 'unavailable']),
  valuePct: DecimalStringSchema.nullable(),
  reason: PremiumDiscountReasonSchema.nullable(),
  label: z.literal('estimated'),
  jupiterRetrievedAt: TimestampSchema.nullable(),
  issuerRetrievedAt: TimestampSchema.nullable(),
}).strict();
export const StockLendSchema = z.object({
  status: z.enum(['available', 'not-found', 'unavailable']),
  vaults: z.array(z.object({
    vaultId: z.number().int().nonnegative(),
    borrowMint: z.string().min(32).max(64),
    borrowSymbol: z.string(),
    maxBorrowLtv: DecimalStringSchema,
    liquidationThreshold: DecimalStringSchema,
  }).strict()).max(12),
  observedAt: TimestampSchema.nullable(),
  sourceUrl: z.string().url().regex(/^https:\/\//),
}).strict();
export const StockSupplySchema = z.object({
  circulating: DecimalStringSchema.nullable(),
  total: DecimalStringSchema.nullable(),
  scope: z.literal('all-xstocks-chain-deployments'),
  retrievedAt: TimestampSchema,
}).strict();
export const StockReserveSchema = z.object({
  status: z.enum(['available', 'not-found', 'unavailable']),
  timestamp: TimestampSchema.nullable(),
  sharesHeld: DecimalStringSchema.nullable(),
  circulatingSupply: DecimalStringSchema.nullable(),
  holdings: z.array(z.object({ provider: z.string(), quantity: DecimalStringSchema, symbol: z.string() }).strict()).max(20),
  retrievedAt: TimestampSchema,
  sourceUrl: z.string().url().regex(/^https:\/\//),
}).strict();
export const StockIntelligenceSchema = z.object({
  issuerIndicativePriceUsd: DecimalStringSchema.nullable(),
  issuerPriceRetrievedAt: TimestampSchema.nullable(),
  issuerPriceSourceUrl: z.string().url().regex(/^https:\/\//),
  market: StockMarketStatusSchema,
  multiplier: StockMultiplierSchema,
  premiumDiscount: StockPremiumDiscountSchema,
  lend: StockLendSchema,
  supply: StockSupplySchema.nullable(),
  reserve: StockReserveSchema.nullable(),
}).strict();
export const StockSourceSchema = z.object({
  label: z.string(),
  url: z.string().url().regex(/^https:\/\//),
  observedAt: TimestampSchema.nullable(),
  retrievedAt: TimestampSchema,
});
export const StockMarketRecordSchema = z.object({
  mint: z.string().min(32).max(64),
  tokenName: z.string().min(1),
  tokenSymbol: z.string().min(1),
  issuerSymbol: z.string().nullable().optional(),
  logoUrl: z.string().url().regex(/^https:\/\//).nullable(),
  identityClass: StockIdentityClassSchema,
  assetType: StockAssetTypeSchema,
  issuerName: z.string().nullable(),
  issuerVerified: z.boolean(),
  underlyingSymbol: z.string().nullable(),
  underlyingIsin: z.string().nullable(),
  listingCountry: z.string().nullable(),
  tokenProgram: z.string().nullable(),
  decimals: z.number().int().min(0).max(30).nullable(),
  priceUsd: DecimalStringSchema.nullable(),
  priceSource: z.enum(['jupiter-price-v3', 'jupiter-tokens-v2-reference', 'none']).optional(),
  referencePriceUsd: DecimalStringSchema.nullable().optional(),
  referencePriceChange24hPct: DecimalStringSchema.nullable().optional(),
  referencePriceRetrievedAt: TimestampSchema.nullable().optional(),
  priceChange24hPct: DecimalStringSchema.nullable(),
  liquidityUsd: DecimalStringSchema.nullable(),
  volume24hUsd: DecimalStringSchema.nullable(),
  tokenizedMarketCapUsd: DecimalStringSchema.nullable(),
  holderCount: z.number().int().nonnegative().nullable(),
  marketUpdatedAt: TimestampSchema.nullable(),
  priceUpdatedAt: TimestampSchema.nullable(),
  retrievedAt: TimestampSchema,
  sources: z.array(StockSourceSchema).min(1).max(3),
  warnings: z.array(z.string()).max(8),
  marketObservation: MarketObservationSchema.optional(),
  intelligence: StockIntelligenceSchema.optional(),
}).strict();

export const StockMarketSortSchema = z.enum(['liquidity', 'price', 'change24h', 'volume24h', 'marketCap', 'name']);
export const StockMarketQuerySchema = z.object({
  search: z.string().trim().max(64).default(''),
  assetType: z.enum(['all', 'equity', 'etf', 'unknown']).default('all'),
  issuer: z.enum(['all', 'confirmed', 'other']).default('all'),
  price: z.enum(['all', 'available', 'v3', 'reference', 'unavailable']).default('all'),
  sort: StockMarketSortSchema.default('liquidity'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const StockMarketPageSchema = z.object({
  status: z.enum(['ready', 'partial', 'stale', 'error', 'rate-limited']),
  records: z.array(StockMarketRecordSchema).max(50),
  pagination: z.object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(50),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }).strict(),
  summary: z.object({
    discovered: z.number().int().nonnegative(),
    issuerConfirmed: z.number().int().nonnegative(),
    priceAvailable: z.number().int().nonnegative(),
    priceV3Available: z.number().int().nonnegative().optional(),
    referencePriceAvailable: z.number().int().nonnegative().optional(),
    liquidMarkets: z.number().int().nonnegative(),
    liquidityUsd: DecimalStringSchema.nullable(),
    volume24hUsd: DecimalStringSchema.nullable(),
    tokenizedMarketCapUsd: DecimalStringSchema.nullable().optional(),
    tokenizedMarketCapCoverage: z.number().int().nonnegative().optional(),
  }).strict(),
  providers: z.object({
    xstocks: z.enum(['ready', 'stale', 'unavailable']),
    jupiterTokens: z.enum(['ready', 'fallback', 'stale', 'unavailable']),
    jupiterPrice: z.enum(['ready', 'partial', 'rate-limited', 'unavailable']),
    xstocksIntelligence: z.enum(['ready', 'partial', 'warming', 'unavailable']).optional(),
    jupiterLend: z.enum(['ready', 'stale', 'unavailable']).optional(),
  }).strict(),
  cache: z.object({
    universe: z.enum(['hit', 'miss', 'shared-inflight', 'stale']),
    visiblePrices: z.enum(['hit', 'miss', 'shared-inflight', 'stale', 'unavailable']),
    universeExpiresAt: TimestampSchema,
    priceWorker: z.object({
      status: z.enum(['idle', 'warming', 'refreshing', 'backoff']),
      cached: z.number().int().nonnegative().max(300),
      target: z.number().int().nonnegative().max(300),
      batchSize: z.literal(50),
      cycleSeconds: z.literal(30),
      lastBatchAt: TimestampSchema.nullable(),
      lastCycleCompletedAt: TimestampSchema.nullable(),
      nextRunAt: TimestampSchema.nullable(),
    }).strict(),
  }).strict(),
  updatedAt: TimestampSchema,
  issues: z.array(z.string()).max(20),
}).strict();
export const StockMarketDetailSchema = z.object({
  status: z.enum(['ready', 'partial', 'stale']),
  record: StockMarketRecordSchema,
  marketEvidence: MarketEvidenceSchema.optional(),
  issues: z.array(z.string()).max(12),
}).strict();

export type StockMarketRecord = z.infer<typeof StockMarketRecordSchema>;
export type StockMarketQuery = z.infer<typeof StockMarketQuerySchema>;
export type StockMarketPage = z.infer<typeof StockMarketPageSchema>;
export type StockMarketDetail = z.infer<typeof StockMarketDetailSchema>;
export type StockIntelligence = z.infer<typeof StockIntelligenceSchema>;
export type PremiumDiscountReason = z.infer<typeof PremiumDiscountReasonSchema>;

const numericSortKey: Record<Exclude<StockMarketQuery['sort'], 'name'>, keyof StockMarketRecord> = {
  liquidity: 'liquidityUsd',
  price: 'priceUsd',
  change24h: 'priceChange24hPct',
  volume24h: 'volume24hUsd',
  marketCap: 'tokenizedMarketCapUsd',
};

function compareNullableDecimal(left: string | null, right: string | null, direction: StockMarketQuery['direction']) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const compared = decimal(left).comparedTo(right);
  return direction === 'asc' ? compared : -compared;
}

export function selectStockMarketPage(records: StockMarketRecord[], query: StockMarketQuery) {
  const needle = query.search.toLocaleLowerCase('en');
  const filtered = records.filter(record => {
    if (query.assetType !== 'all' && record.assetType !== query.assetType) return false;
    if (query.issuer === 'confirmed' && !record.issuerVerified) return false;
    if (query.issuer === 'other' && record.issuerVerified) return false;
    if (query.price === 'available' && record.priceUsd === null) return false;
    if (query.price === 'v3' && (record.priceUsd === null || record.priceSource !== 'jupiter-price-v3')) return false;
    if (query.price === 'reference' && (record.priceUsd === null || record.priceSource !== 'jupiter-tokens-v2-reference')) return false;
    if (query.price === 'unavailable' && record.priceUsd !== null) return false;
    if (!needle) return true;
    return [record.tokenName, record.tokenSymbol, record.underlyingSymbol, record.underlyingIsin, record.mint]
      .some(value => value?.toLocaleLowerCase('en').includes(needle));
  });
  const sorted = filtered.map((record, index) => ({ record, index })).sort((left, right) => {
    let result: number;
    if (query.sort === 'name') {
      result = left.record.tokenName.localeCompare(right.record.tokenName, 'en', { sensitivity: 'base' });
      if (query.direction === 'desc') result = -result;
    } else {
      const key = numericSortKey[query.sort];
      result = compareNullableDecimal(left.record[key] as string | null, right.record[key] as string | null, query.direction);
    }
    return result || left.index - right.index;
  }).map(item => item.record);
  const totalPages = sorted.length ? Math.ceil(sorted.length / query.pageSize) : 0;
  const page = totalPages ? Math.min(query.page, totalPages) : 1;
  const start = (page - 1) * query.pageSize;
  return { records: sorted.slice(start, start + query.pageSize), total: sorted.length, totalPages, page };
}

export function summarizeStockMarket(records: StockMarketRecord[]) {
  const sum = (field: 'liquidityUsd' | 'volume24hUsd' | 'tokenizedMarketCapUsd') => {
    const values = records.map(record => record[field]).filter((value): value is string => value !== null);
    return values.length ? values.reduce((total, value) => total.plus(value), decimal('0')).toFixed() : null;
  };
  return {
    discovered: records.length,
    issuerConfirmed: records.filter(record => record.issuerVerified).length,
    priceAvailable: records.filter(record => record.priceUsd !== null).length,
    priceV3Available: records.filter(record => record.priceUsd !== null && record.priceSource === 'jupiter-price-v3').length,
    referencePriceAvailable: records.filter(record => record.priceUsd !== null && record.priceSource === 'jupiter-tokens-v2-reference').length,
    liquidMarkets: records.filter(record => record.liquidityUsd !== null && decimal(record.liquidityUsd).gt(0)).length,
    liquidityUsd: sum('liquidityUsd'),
    volume24hUsd: sum('volume24hUsd'),
    tokenizedMarketCapUsd: sum('tokenizedMarketCapUsd'),
    tokenizedMarketCapCoverage: records.filter(record => record.tokenizedMarketCapUsd !== null).length,
  };
}
