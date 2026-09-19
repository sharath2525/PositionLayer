import 'server-only';
import { z } from 'zod';
import { decimal } from '@/domain/amounts';
import { PoolObservationSchema, ProviderFailureSchema, type PoolObservation, type ProviderFailure } from '@/domain/market-observations';
import type { StockMarketRecord } from '@/domain/stocks';
import { observeProviderCall } from '@/services/monitoring/instrument-provider';
import { recordMarketEvent } from '@/services/monitoring/log-manager';

export const METEORA_DLMM_BASE_URL = 'https://dlmm.datapi.meteora.ag';
export const METEORA_DAMM_V2_BASE_URL = 'https://damm-v2.datapi.meteora.ag';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const DecimalNumberSchema = z.number().finite().nonnegative();
const TokenSchema = z.object({
  address: z.string().min(32).max(64),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(30),
  is_verified: z.boolean(),
}).passthrough();
const WindowSchema = z.object({ '24h': DecimalNumberSchema.nullable().optional() }).passthrough();
export const MeteoraPoolSchema = z.object({
  address: z.string().min(32).max(64),
  name: z.string(),
  token_x: TokenSchema,
  token_y: TokenSchema,
  current_price: z.number().finite().positive(),
  tvl: DecimalNumberSchema,
  volume: WindowSchema.nullable().optional(),
  fees: WindowSchema.nullable().optional(),
  is_blacklisted: z.boolean(),
}).passthrough();
const PoolPageSchema = z.object({
  total: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  current_page: z.number().int().min(1),
  page_size: z.number().int().min(1).max(1000),
  data: z.array(z.unknown()).max(1000),
}).passthrough();

export type MeteoraProtocol = 'dlmm' | 'damm-v2';
export type MeteoraPool = z.infer<typeof MeteoraPoolSchema>;
export type IndexedMeteoraPool = { protocol: MeteoraProtocol; pool: MeteoraPool };
export type MeteoraPoolIndex = { pools: IndexedMeteoraPool[]; retrievedAt: string; protocolsReady: MeteoraProtocol[]; issues: string[] };

export class MeteoraProviderError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = 'MeteoraProviderError';
    this.failure = ProviderFailureSchema.parse(failure);
  }
  get kind() { return this.failure.kind; }
  get status() { return this.failure.httpStatus; }
}

function baseUrl(protocol: MeteoraProtocol) {
  return protocol === 'dlmm' ? METEORA_DLMM_BASE_URL : METEORA_DAMM_V2_BASE_URL;
}

function providerError(kind: ProviderFailure['kind'], operation: string, message: string, httpStatus: number | null = null, retryAfterSeconds: number | null = null) {
  return new MeteoraProviderError({ provider: 'METEORA', kind, operation, httpStatus, retryAfterSeconds, message });
}

async function meteoraJson<T>(url: string, schema: z.ZodType<T>, operation: 'meteora_pool_index' | 'meteora_pool_detail', signal?: AbortSignal): Promise<T> {
  return observeProviderCall({ provider: 'METEORA', operation }, async () => {
    const timeout = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store' });
    } catch {
      if (signal?.aborted) throw providerError('aborted', operation, 'Meteora request was cancelled.');
      if (timeout.aborted) throw providerError('timeout', operation, 'Meteora request timed out.');
      throw providerError('network', operation, 'Meteora network request failed.');
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    if (!response.ok) {
      throw providerError(response.status === 429 ? 'rate-limited' : 'http', operation,
        response.status === 429 ? 'Meteora rate limit reached.' : `Meteora returned HTTP ${response.status}.`,
        response.status, Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter) : null);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw providerError('invalid-json', operation, 'Meteora returned invalid JSON.', response.status); }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw providerError('schema', operation, 'Meteora response failed schema validation.', response.status);
    return parsed.data;
  });
}

export async function readMeteoraProtocolIndex(protocol: MeteoraProtocol, mints: string[], minimumTvlUsd: string, signal?: AbortSignal) {
  const allowed = new Set([...new Set(mints)].slice(0, 300));
  const pools: MeteoraPool[] = [];
  const params = new URLSearchParams({ page: '1', page_size: '1000', sort_by: 'tvl:desc', filter_by: `is_blacklisted=false && tvl>=${minimumTvlUsd}` });
  const first = await meteoraJson(`${baseUrl(protocol)}/pools?${params}`, PoolPageSchema, 'meteora_pool_index', signal);
  const pages = Math.min(first.pages, 3);
  for (let page = 1; page <= pages; page++) {
    const response = page === 1 ? first : await meteoraJson(`${baseUrl(protocol)}/pools?${new URLSearchParams({ ...Object.fromEntries(params), page: String(page) })}`, PoolPageSchema, 'meteora_pool_index', signal);
    const validated = response.data.flatMap(value => {
      const parsed = MeteoraPoolSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
    if (validated.length !== response.data.length) recordMarketEvent({ severity: 'WARN', provider: 'METEORA', operation: 'meteora_pool_index', status: 'NORMALIZATION_FAILED', errorCode: 'NORMALIZATION', message: 'Some Meteora pool records failed validation and were excluded.' });
    pools.push(...validated.filter(pool =>
      (allowed.has(pool.token_x.address) && pool.token_y.address === USDC_MINT)
      || (allowed.has(pool.token_y.address) && pool.token_x.address === USDC_MINT)));
  }
  return [...new Map(pools.map(pool => [pool.address, pool])).values()];
}

export async function readMeteoraPoolIndexes(mints: string[], minimumTvlUsd: string, signal?: AbortSignal): Promise<MeteoraPoolIndex> {
  const results = await Promise.allSettled([
    readMeteoraProtocolIndex('dlmm', mints, minimumTvlUsd, signal),
    readMeteoraProtocolIndex('damm-v2', mints, minimumTvlUsd, signal),
  ]);
  const pools: IndexedMeteoraPool[] = [];
  const protocolsReady: MeteoraProtocol[] = [];
  const issues: string[] = [];
  results.forEach((result, index) => {
    const protocol: MeteoraProtocol = index === 0 ? 'dlmm' : 'damm-v2';
    if (result.status === 'fulfilled') { pools.push(...result.value.map(pool => ({ protocol, pool }))); protocolsReady.push(protocol); }
    else issues.push(`Meteora ${protocol.toUpperCase()} pool index is temporarily unavailable.`);
  });
  if (!protocolsReady.length) throw providerError('network', 'meteora_pool_index', 'All Meteora pool indexes are unavailable.');
  return { pools: [...new Map(pools.map(entry => [entry.pool.address, entry])).values()], retrievedAt: new Date().toISOString(), protocolsReady, issues };
}

export async function readMeteoraPoolDetail(protocol: MeteoraProtocol, address: string, signal?: AbortSignal) {
  return meteoraJson(`${baseUrl(protocol)}/pools/${encodeURIComponent(address)}`, MeteoraPoolSchema, 'meteora_pool_detail', signal);
}

export function minimumMeteoraLiquidityUsd() {
  const configured = Number(process.env.METEORA_MIN_LIQUIDITY_USD);
  return decimal(String(Number.isFinite(configured) && configured >= 0 ? configured : 1_000)).toFixed();
}

export function selectMeteoraPool(record: StockMarketRecord, pools: IndexedMeteoraPool[], retrievedAt: string): PoolObservation | null {
  if (!record.tokenProgram || record.decimals === null) return null;
  const eligible = pools.flatMap(({ pool, protocol }) => {
    if (pool.is_blacklisted || pool.tvl < Number(minimumMeteoraLiquidityUsd())) return [];
    const stockIsX = pool.token_x.address === record.mint && pool.token_y.address === USDC_MINT;
    const stockIsY = pool.token_y.address === record.mint && pool.token_x.address === USDC_MINT;
    if (!stockIsX && !stockIsY) return [];
    const stockToken = stockIsX ? pool.token_x : pool.token_y;
    const quoteToken = stockIsX ? pool.token_y : pool.token_x;
    if (stockToken.decimals !== record.decimals || quoteToken.decimals !== 6 || !stockToken.is_verified || !quoteToken.is_verified) return [];
    const pairPrice = decimal(String(pool.current_price));
    const priceUsd = stockIsX ? pairPrice : decimal('1').div(pairPrice);
    if (!priceUsd.isFinite() || priceUsd.lte(0)) return [];
    return [{ pool, protocol, stockIsX, pairPrice, priceUsd }];
  }).sort((left, right) => decimal(String(right.pool.tvl)).comparedTo(String(left.pool.tvl)));
  const selected = eligible[0];
  if (!selected) return null;
  return PoolObservationSchema.parse({
    source: selected.protocol === 'dlmm' ? 'meteora-dlmm' : 'meteora-damm-v2',
    poolAddress: selected.pool.address, stockMint: record.mint, quoteMint: USDC_MINT,
    quoteSymbol: 'USDC', orientation: selected.stockIsX ? 'stock-x' : 'stock-y',
    pairPrice: selected.pairPrice.toFixed(), priceUsd: selected.priceUsd.toFixed(),
    tvlUsd: decimal(String(selected.pool.tvl)).toFixed(), liquidityUsd: decimal(String(selected.pool.tvl)).toFixed(),
    volume24hUsd: selected.pool.volume?.['24h'] == null ? null : decimal(String(selected.pool.volume['24h'])).toFixed(),
    fees24hUsd: selected.pool.fees?.['24h'] == null ? null : decimal(String(selected.pool.fees['24h'])).toFixed(),
    blacklisted: false, providerObservedAt: null, retrievedAt,
    sourceUrl: `${baseUrl(selected.protocol)}/pools/${selected.pool.address}`,
  });
}
