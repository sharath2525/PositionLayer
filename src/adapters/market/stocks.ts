import 'server-only';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { unpackMint } from '@solana/spl-token';
import { decimal } from '@/domain/amounts';
import { StockMarketRecordSchema, type StockMarketRecord } from '@/domain/stocks';
import { projectJupiterObservation, type MarketUpdateFailure } from '@/domain/market-observations';
import { jupiterJson } from '@/adapters/jupiter-api/client';
import type { MonitoringOperation } from '@/domain/monitoring';
import { observeProviderCall } from '@/services/monitoring/instrument-provider';
import { recordMarketEvent } from '@/services/monitoring/log-manager';
import { createConnection } from '@/adapters/solana/connection';
import { featuredXstocks } from '@/config/featured-stocks';
import { isVerifiedEtfUnderlying } from '@/config/verified-etf-underlyings';
import issuerCatalogSnapshot from '@/config/issuer-catalog-snapshot.json';

export const XSTOCKS_ASSETS_URL = 'https://api.xstocks.fi/api/v2/public/assets';
const JUPITER_TOKENS_DOC = 'https://developers.jup.ag/docs/tokens/token-information';
const JUPITER_PRICE_DOC = 'https://developers.jup.ag/docs/price';
export const JUPITER_LEND_VAULTS_URL = 'https://api.jup.ag/lend/v1/borrow/vaults';

const TimestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)));
const XstockDeploymentSchema = z.object({ address: z.string().min(32).max(64), network: z.string() }).passthrough();
export const XstockAssetSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1),
  symbol: z.string().min(1),
  isin: z.string().nullable().optional(),
  underlyingSymbol: z.string().nullable().optional(),
  underlyingIsin: z.string().nullable().optional(),
  underlying: z.object({
    symbol: z.string().nullable().optional(),
    isin: z.string().nullable().optional(),
    type: z.enum(['Equity', 'ETF']).nullable().optional(),
    listingCountry: z.string().nullable().optional(),
  }).nullable().optional(),
  logo: z.string().url().regex(/^https:\/\//).nullable().optional(),
  isTradingHalted: z.boolean().optional(),
  trading: z.object({
    currency: z.string().nullable().optional(),
    currentPeriod: z.enum(['market', 'extended', 'overnight', 'closed']).nullable().optional(),
    openNow: z.boolean().nullable().optional(),
    nextChangeAt: TimestampSchema.nullable().optional(),
    isTradingHalted: z.boolean().optional(),
  }).passthrough().nullable().optional(),
  verifiedAt: TimestampSchema.nullable().optional(),
  deployments: z.array(XstockDeploymentSchema),
}).passthrough();
const XstockPageSchema = z.object({
  nodes: z.array(XstockAssetSchema).max(100),
  page: z.object({ currentPage: z.number().int().nonnegative(), hasNextPage: z.boolean() }).passthrough(),
}).passthrough();

const JupiterStatsSchema = z.object({
  priceChange: z.number().finite().nullable().optional(),
  buyVolume: z.number().finite().nonnegative().nullable().optional(),
  sellVolume: z.number().finite().nonnegative().nullable().optional(),
}).passthrough().nullable().optional();
export const JupiterStockTokenSchema = z.object({
  id: z.string().min(32).max(64),
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(30),
  tokenProgram: z.string().min(1),
  icon: z.string().url().regex(/^https:\/\//).nullable().optional(),
  isVerified: z.boolean().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  usdPrice: z.number().finite().positive().nullable().optional(),
  liquidity: z.number().finite().nonnegative().nullable().optional(),
  mcap: z.number().finite().nonnegative().nullable().optional(),
  holderCount: z.number().int().nonnegative().nullable().optional(),
  stats24h: JupiterStatsSchema,
  updatedAt: TimestampSchema.nullable().optional(),
}).passthrough();
const JupiterStockTokenListSchema = z.array(JupiterStockTokenSchema).max(5000);
const JupiterPriceEntrySchema = z.object({
  usdPrice: z.number().finite().positive(),
  blockId: z.number().int().nonnegative(),
  decimals: z.number().int().min(0).max(30),
  priceChange24h: z.number().finite().nullable().optional(),
}).passthrough();
const JupiterPriceResponseSchema = z.record(z.string(), z.unknown());
const XstockPriceSchema = z.object({ quote: z.number().finite().positive().nullable() }).strict();
const XstockMultiplierSchema = z.object({
  currentMultiplier: z.number().finite().positive().nullable(),
  newMultiplier: z.number().finite().nonnegative().nullable(),
  activationDateTime: z.union([z.number().finite().nonnegative(), TimestampSchema]).nullable(),
  reason: z.string().nullable(),
}).strict();
const SupplySchema = z.object({ value: z.number().finite().nonnegative() }).strict();
const ReserveSchema = z.object({
  symbol: z.string(), timestamp: TimestampSchema, sharesHeld: z.string().regex(/^\d+(?:\.\d+)?$/),
  circulatingSupply: z.string().regex(/^\d+(?:\.\d+)?$/),
  holdings: z.array(z.object({ provider: z.string(), quantity: z.string().regex(/^\d+(?:\.\d+)?$/), symbol: z.string() }).strict()).max(20),
}).strict();
const LendTokenSchema = z.object({ address: z.string().min(32).max(64), symbol: z.string(), name: z.string().optional() }).passthrough();
const LendVaultSchema = z.object({
  id: z.number().int().nonnegative(), supplyToken: LendTokenSchema, borrowToken: LendTokenSchema,
  collateralFactor: z.string().regex(/^\d+$/), liquidationThreshold: z.string().regex(/^\d+$/),
}).passthrough();
const LendVaultListSchema = z.array(LendVaultSchema).max(1000);
const SolanaMintMetadataSchema = z.object({
  mint: z.string().min(32).max(64), tokenProgram: z.string().min(32).max(64), decimals: z.number().int().min(0).max(30), retrievedAt: TimestampSchema,
}).strict();

export type XstockAsset = z.infer<typeof XstockAssetSchema>;
export type JupiterStockToken = z.infer<typeof JupiterStockTokenSchema>;
export type JupiterMarketPrice = z.infer<typeof JupiterPriceEntrySchema> & { retrievedAt: string };
export type JupiterLendVault = z.infer<typeof LendVaultSchema>;
export type SolanaMintMetadata = z.infer<typeof SolanaMintMetadataSchema>;

function numberString(value: number | null | undefined) {
  return value == null ? null : decimal(String(value)).toFixed();
}

function volume24h(stats: z.infer<typeof JupiterStatsSchema>) {
  const buy = stats?.buyVolume;
  const sell = stats?.sellVolume;
  if (buy == null && sell == null) return null;
  return decimal(String(buy || 0)).plus(String(sell || 0)).toFixed();
}

function assetType(asset: XstockAsset, mint: string): StockMarketRecord['assetType'] {
  if (asset.underlying?.type === 'Equity') return 'equity';
  if (asset.underlying?.type === 'ETF') return 'etf';
  const reviewed = featuredXstocks.find(item => item.mint === mint && item.symbol === asset.symbol
    && item.underlyingSymbol === (asset.underlying?.symbol || asset.underlyingSymbol)
    && item.underlyingIsin === (asset.underlying?.isin || asset.underlyingIsin));
  if (reviewed) return reviewed.assetClass === 'etf' ? 'etf' : 'equity';
  if (isVerifiedEtfUnderlying(asset.underlying?.symbol || asset.underlyingSymbol, asset.underlying?.isin || asset.underlyingIsin)) return 'etf';
  return 'unknown';
}

function solanaDeployments(asset: XstockAsset) {
  return asset.deployments.filter(deployment => deployment.network.toLocaleLowerCase('en') === 'solana');
}

export function solanaDeploymentMints(assets: XstockAsset[]) {
  return [...new Set(assets.flatMap(asset => solanaDeployments(asset).map(deployment => deployment.address)))];
}

export function activeSolanaXstockAssets(assets: XstockAsset[]) {
  return assets.filter(asset => asset.isTradingHalted !== true && asset.trading?.isTradingHalted !== true && solanaDeployments(asset).length > 0);
}

function issuerRecord(asset: XstockAsset, mint: string, token: JupiterStockToken | undefined, retrievedAt: string): StockMarketRecord {
  const observedAt = token?.updatedAt ? new Date(token.updatedAt).toISOString() : null;
  const underlyingSymbol = asset.underlying?.symbol || asset.underlyingSymbol || null;
  const underlyingIsin = asset.underlying?.isin || asset.underlyingIsin || asset.isin || null;
  const warnings: string[] = [];
  if (!token) warnings.push('Jupiter token metadata is unavailable for this exact issuer deployment mint.');
  if (!token?.usdPrice) warnings.push('Onchain Jupiter USD price is unavailable; it is not treated as zero.');
  if (assetType(asset, mint) === 'unknown') warnings.push('The issuer did not classify this record as Equity or ETF.');
  const halted = asset.isTradingHalted === true || asset.trading?.isTradingHalted === true;
  const priceUrl = `${XSTOCKS_ASSETS_URL}/${encodeURIComponent(asset.symbol)}/price-data`;
  const issuerLogoUrl = asset.logo || `https://xstocks-metadata.backed.fi/logos/tokens/${encodeURIComponent(asset.symbol)}.png`;
  return StockMarketRecordSchema.parse({
    mint,
    tokenName: token?.name || asset.name,
    tokenSymbol: token?.symbol || asset.symbol,
    issuerSymbol: asset.symbol,
    logoUrl: issuerLogoUrl,
    identityClass: 'issuer-confirmed-xstock',
    assetType: assetType(asset, mint),
    issuerName: 'Backed Assets (JE) Limited',
    issuerVerified: true,
    underlyingSymbol,
    underlyingIsin,
    listingCountry: asset.underlying?.listingCountry || null,
    tokenProgram: token?.tokenProgram || null,
    decimals: token?.decimals ?? null,
    priceUsd: numberString(token?.usdPrice),
    priceSource: token?.usdPrice ? 'jupiter-tokens-v2-reference' : 'none',
    referencePriceUsd: numberString(token?.usdPrice),
    referencePriceChange24hPct: numberString(token?.stats24h?.priceChange),
    referencePriceRetrievedAt: token?.usdPrice ? retrievedAt : null,
    priceChange24hPct: numberString(token?.stats24h?.priceChange),
    liquidityUsd: numberString(token?.liquidity),
    volume24hUsd: volume24h(token?.stats24h),
    tokenizedMarketCapUsd: numberString(token?.mcap),
    holderCount: token?.holderCount ?? null,
    marketUpdatedAt: observedAt,
    priceUpdatedAt: observedAt,
    retrievedAt,
    sources: [
      { label: 'xStocks public asset registry', url: `${XSTOCKS_ASSETS_URL}/${encodeURIComponent(asset.symbol)}`, observedAt: asset.verifiedAt ? new Date(asset.verifiedAt).toISOString() : null, retrievedAt },
      ...(token ? [{ label: 'Jupiter Tokens V2', url: JUPITER_TOKENS_DOC, observedAt, retrievedAt }] : []),
    ],
    warnings,
    intelligence: {
      issuerIndicativePriceUsd: null,
      issuerPriceRetrievedAt: null,
      issuerPriceSourceUrl: priceUrl,
      market: {
        period: asset.trading?.currentPeriod || null,
        openNow: asset.trading?.openNow ?? null,
        tradingHalted: halted,
        currency: asset.trading?.currency || null,
        nextChangeAt: asset.trading?.nextChangeAt || null,
      },
      multiplier: { status: 'unavailable', current: null, pending: null, activationAt: null, reason: null },
      premiumDiscount: {
        status: 'unavailable', valuePct: null, reason: token?.usdPrice ? 'no-issuer-price' : 'no-jupiter-price', label: 'estimated',
        jupiterRetrievedAt: observedAt, issuerRetrievedAt: null,
      },
      lend: { status: 'unavailable', vaults: [], observedAt: null, sourceUrl: JUPITER_LEND_VAULTS_URL },
      supply: null,
      reserve: null,
    },
  });
}

function taggedRecord(token: JupiterStockToken, retrievedAt: string): StockMarketRecord {
  const observedAt = token.updatedAt ? new Date(token.updatedAt).toISOString() : null;
  const warnings = ['Tagged as a stock by Jupiter, but not exact-matched to an issuer-confirmed xStocks Solana deployment.'];
  if (!token.usdPrice) warnings.push('Onchain Jupiter USD price is unavailable; it is not treated as zero.');
  return StockMarketRecordSchema.parse({
    mint: token.id,
    tokenName: token.name,
    tokenSymbol: token.symbol,
    issuerSymbol: null,
    logoUrl: token.icon || null,
    identityClass: 'jupiter-stock-tagged',
    assetType: 'unknown',
    issuerName: null,
    issuerVerified: false,
    underlyingSymbol: null,
    underlyingIsin: null,
    listingCountry: null,
    tokenProgram: token.tokenProgram,
    decimals: token.decimals,
    priceUsd: numberString(token.usdPrice),
    priceSource: token.usdPrice ? 'jupiter-tokens-v2-reference' : 'none',
    referencePriceUsd: numberString(token.usdPrice),
    referencePriceChange24hPct: numberString(token.stats24h?.priceChange),
    referencePriceRetrievedAt: token.usdPrice ? retrievedAt : null,
    priceChange24hPct: numberString(token.stats24h?.priceChange),
    liquidityUsd: numberString(token.liquidity),
    volume24hUsd: volume24h(token.stats24h),
    tokenizedMarketCapUsd: numberString(token.mcap),
    holderCount: token.holderCount ?? null,
    marketUpdatedAt: observedAt,
    priceUpdatedAt: observedAt,
    retrievedAt,
    sources: [{ label: 'Jupiter Tokens V2 stocks tag', url: JUPITER_TOKENS_DOC, observedAt, retrievedAt }],
    warnings,
    intelligence: {
      issuerIndicativePriceUsd: null,
      issuerPriceRetrievedAt: null,
      issuerPriceSourceUrl: JUPITER_TOKENS_DOC,
      market: { period: null, openNow: null, tradingHalted: null, currency: null, nextChangeAt: null },
      multiplier: { status: 'unavailable', current: null, pending: null, activationAt: null, reason: null },
      premiumDiscount: { status: 'unavailable', valuePct: null, reason: 'issuer-unverified', label: 'estimated', jupiterRetrievedAt: observedAt, issuerRetrievedAt: null },
      lend: { status: 'unavailable', vaults: [], observedAt: null, sourceUrl: JUPITER_LEND_VAULTS_URL },
      supply: null,
      reserve: null,
    },
  });
}

export function normalizeStockUniverse(xstocksInput: unknown[], jupiterInput: unknown[], retrievedAt = new Date().toISOString()) {
  const xstocks = xstocksInput.map(input => XstockAssetSchema.parse(input));
  const tokens = jupiterInput.map(input => JupiterStockTokenSchema.parse(input));
  const tokensByMint = new Map(tokens.map(token => [token.id, token]));
  const byMint = new Map<string, StockMarketRecord>();
  for (const asset of xstocks) for (const deployment of solanaDeployments(asset)) {
    if (!byMint.has(deployment.address)) byMint.set(deployment.address, issuerRecord(asset, deployment.address, tokensByMint.get(deployment.address), retrievedAt));
  }
  for (const token of tokens) if (!byMint.has(token.id)) byMint.set(token.id, taggedRecord(token, retrievedAt));
  return [...byMint.values()].sort((left, right) => left.tokenName.localeCompare(right.tokenName, 'en', { sensitivity: 'base' }) || left.mint.localeCompare(right.mint));
}

export function mergeJupiterStockMetadata(records: StockMarketRecord[], jupiterInput: unknown[], retrievedAt = new Date().toISOString()) {
  const tokens = jupiterInput.map(input => JupiterStockTokenSchema.parse(input));
  const tokensByMint = new Map(tokens.map(token => [token.id, token]));
  return records.map(record => {
    const token = tokensByMint.get(record.mint);
    if (!token) return record;
    const observedAt = token.updatedAt ? new Date(token.updatedAt).toISOString() : null;
    const warnings = record.warnings.filter(warning =>
      !warning.startsWith('Jupiter token metadata is unavailable')
      && !(token.usdPrice && warning.startsWith('Onchain Jupiter USD price is unavailable')),
    );
    return StockMarketRecordSchema.parse({
      ...record,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      logoUrl: record.logoUrl || token.icon || null,
      tokenProgram: token.tokenProgram,
      decimals: token.decimals,
      priceUsd: record.priceSource === 'jupiter-price-v3' ? record.priceUsd : numberString(token.usdPrice),
      priceSource: record.priceSource === 'jupiter-price-v3' ? record.priceSource : token.usdPrice ? 'jupiter-tokens-v2-reference' : 'none',
      referencePriceUsd: numberString(token.usdPrice),
      referencePriceChange24hPct: numberString(token.stats24h?.priceChange),
      referencePriceRetrievedAt: token.usdPrice ? retrievedAt : null,
      priceChange24hPct: record.priceSource === 'jupiter-price-v3' ? record.priceChange24hPct : numberString(token.stats24h?.priceChange),
      liquidityUsd: numberString(token.liquidity),
      volume24hUsd: volume24h(token.stats24h),
      tokenizedMarketCapUsd: numberString(token.mcap),
      holderCount: token.holderCount ?? null,
      marketUpdatedAt: observedAt,
      retrievedAt,
      sources: [
        ...record.sources.filter(source => source.label !== 'Jupiter Tokens V2'),
        { label: 'Jupiter Tokens V2', url: JUPITER_TOKENS_DOC, observedAt, retrievedAt },
      ].slice(0, 3),
      warnings,
    });
  });
}

export function mergeSolanaMintMetadata(records: StockMarketRecord[], metadataInput: unknown[]) {
  const metadata = metadataInput.map(input => SolanaMintMetadataSchema.parse(input));
  const byMint = new Map(metadata.map(row => [row.mint, row]));
  return records.map(record => {
    const mint = byMint.get(record.mint);
    if (!mint) return record;
    return StockMarketRecordSchema.parse({
      ...record,
      tokenProgram: record.tokenProgram || mint.tokenProgram,
      decimals: record.decimals ?? mint.decimals,
      sources: [
        ...record.sources.filter(source => source.label !== 'Solana RPC mint account'),
        { label: 'Solana RPC mint account', url: `https://explorer.solana.com/address/${record.mint}`, observedAt: null, retrievedAt: mint.retrievedAt },
      ].slice(0, 3),
    });
  });
}

export function featuredXstockAssets() {
  return featuredXstocks.map(record => XstockAssetSchema.parse({
    name: record.name,
    symbol: record.symbol,
    underlyingSymbol: record.underlyingSymbol,
    underlyingIsin: record.underlyingIsin,
    underlying: {
      symbol: record.underlyingSymbol,
      isin: record.underlyingIsin,
      type: record.assetClass === 'etf' ? 'ETF' : 'Equity',
      listingCountry: 'US',
    },
    logo: `https://xstocks-metadata.backed.fi/logos/tokens/${record.symbol}.png`,
    verifiedAt: record.verifiedAt,
    deployments: [{ address: record.mint, network: 'Solana' }],
  }));
}

const IssuerSnapshotSchema = z.object({
  retrievedAt: TimestampSchema,
  source: z.string().url().regex(/^https:\/\//),
  assets: z.array(z.object({
    symbol: z.string().min(1), name: z.string().min(1), mint: z.string().min(32).max(64),
    underlyingSymbol: z.string().nullable(), underlyingIsin: z.string().nullable(),
    assetType: z.enum(['equity', 'etf', 'unknown']), listingCountry: z.string().nullable(),
    logoUrl: z.string().url().regex(/^https:\/\//).nullable(), halted: z.boolean(),
  }).strict()).min(300).max(2000),
}).strict().parse(issuerCatalogSnapshot);

/** A dated issuer identity snapshot, never a cached market-price feed. */
export function snapshotXstockAssets() {
  const assets = IssuerSnapshotSchema.assets.map(row => XstockAssetSchema.parse({
    name: row.name, symbol: row.symbol, underlyingSymbol: row.underlyingSymbol,
    underlyingIsin: row.underlyingIsin, logo: row.logoUrl, isTradingHalted: row.halted,
    underlying: { symbol: row.underlyingSymbol, isin: row.underlyingIsin,
      type: row.assetType === 'equity' ? 'Equity' : row.assetType === 'etf' ? 'ETF' : null,
      listingCountry: row.listingCountry },
    verifiedAt: IssuerSnapshotSchema.retrievedAt,
    deployments: [{ network: 'Solana', address: row.mint }],
  }));
  if (solanaDeploymentMints(activeSolanaXstockAssets(assets)).length < 300) {
    throw Error('Reviewed issuer snapshot has fewer than 300 active unique Solana mints.');
  }
  return { assets, verifiedAt: IssuerSnapshotSchema.retrievedAt, source: IssuerSnapshotSchema.source };
}

export function mergeVisiblePrices(records: StockMarketRecord[], prices: Map<string, JupiterMarketPrice>) {
  return records.map(record => {
    const price = prices.get(record.mint);
    if (!price || (record.decimals !== null && price.decimals !== record.decimals)) return record;
    const warnings = record.warnings.filter(warning => !warning.startsWith('Onchain Jupiter USD price is unavailable'));
    return StockMarketRecordSchema.parse({
      ...record,
      priceUsd: numberString(price.usdPrice),
      priceSource: 'jupiter-price-v3',
      priceChange24hPct: numberString(price.priceChange24h) ?? record.priceChange24hPct,
      priceUpdatedAt: price.retrievedAt,
      intelligence: record.intelligence ? {
        ...record.intelligence,
        premiumDiscount: {
          ...record.intelligence.premiumDiscount,
          reason: record.issuerVerified ? 'no-issuer-price' : 'issuer-unverified',
          jupiterRetrievedAt: price.retrievedAt,
        },
      } : undefined,
      sources: [...record.sources.filter(source => source.label !== 'Jupiter Price V3'), {
        label: 'Jupiter Price V3', url: JUPITER_PRICE_DOC, observedAt: null, retrievedAt: price.retrievedAt,
      }].slice(0, 3),
      warnings,
    });
  });
}

/**
 * Compatibility projection for resolver v2. It preserves the validated value's
 * original timestamp, ages it explicitly, and stops exposing it as a current
 * price after the configured unavailable cutoff.
 */
export function mergeVisiblePricesV2(
  records: StockMarketRecord[],
  prices: Map<string, JupiterMarketPrice>,
  failures: Map<string, MarketUpdateFailure> = new Map(),
  now = Date.now(),
) {
  return records.map(record => {
    const current = prices.get(record.mint);
    const decimalsMismatch = current !== undefined && record.decimals !== null && current.decimals !== record.decimals;
    const sourcePrice = decimalsMismatch ? undefined : current;
    const observation = projectJupiterObservation({
      mint: record.mint,
      priceUsd: sourcePrice ? numberString(sourcePrice.usdPrice) : null,
      priceChange24hPct: sourcePrice ? numberString(sourcePrice.priceChange24h) : null,
      blockId: sourcePrice?.blockId ?? null,
      decimals: sourcePrice?.decimals ?? record.decimals,
      retrievedAt: sourcePrice?.retrievedAt ?? null,
      updateFailure: decimalsMismatch ? {
        kind: 'decimals-mismatch', at: new Date(now).toISOString(),
        message: 'Jupiter price decimals did not match the verified token decimals.',
      } : failures.get(record.mint) ?? null,
    }, now);
    const hasValidatedPrice = observation.lastKnownPriceUsd !== null && observation.retrievedAt !== null;
    const referencePrice = record.referencePriceUsd ?? null;
    const useReference = observation.priceUsd === null && referencePrice !== null;
    const warnings = record.warnings
      .filter(warning => !warning.startsWith('Onchain Jupiter USD price is unavailable') && !warning.startsWith('Jupiter last-known-good price'));
    if (observation.freshness === 'DELAYED') warnings.push('Jupiter last-known-good price is delayed; its original timestamp is preserved.');
    if (observation.freshness === 'STALE') warnings.push('Jupiter last-known-good price is stale and display-only.');
    if (observation.freshness === 'UNAVAILABLE') warnings.push('Onchain Jupiter USD price is unavailable and never treated as zero.');
    if (useReference) warnings.push('Jupiter Tokens V2 reference quote is display-only; it is not a Price V3 observation or eligible for sensitive calculations.');
    return StockMarketRecordSchema.parse({
      ...record,
      priceUsd: observation.priceUsd ?? referencePrice,
      priceSource: observation.priceUsd !== null ? 'jupiter-price-v3' : useReference ? 'jupiter-tokens-v2-reference' : 'none',
      priceChange24hPct: observation.priceUsd !== null ? observation.priceChange24hPct : useReference ? record.referencePriceChange24hPct ?? null : null,
      priceUpdatedAt: observation.priceUsd !== null ? observation.retrievedAt : useReference ? record.referencePriceRetrievedAt ?? null : null,
      marketObservation: observation,
      intelligence: record.intelligence ? {
        ...record.intelligence,
        premiumDiscount: {
          ...record.intelligence.premiumDiscount,
          reason: hasValidatedPrice ? 'no-issuer-price' : record.issuerVerified ? 'no-jupiter-price' : 'issuer-unverified',
          jupiterRetrievedAt: observation.retrievedAt,
        },
      } : undefined,
      sources: hasValidatedPrice ? [...record.sources.filter(source => source.label !== 'Jupiter Price V3'), {
        label: 'Jupiter Price V3', url: JUPITER_PRICE_DOC, observedAt: null, retrievedAt: observation.retrievedAt!,
      }].slice(0, 3) : record.sources.filter(source => source.label !== 'Jupiter Price V3'),
      warnings: warnings.slice(0, 8),
    });
  });
}

export function selectTopIssuerRecords(records: StockMarketRecord[], limit = 300) {
  const numeric = (record: StockMarketRecord, field: 'liquidityUsd' | 'volume24hUsd' | 'tokenizedMarketCapUsd') => record[field];
  const compare = (left: string | null, right: string | null) => {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return -decimal(left).comparedTo(right);
  };
  const ranked = records.filter(record => record.issuerVerified).sort((left, right) => {
    if ((left.priceUsd !== null) !== (right.priceUsd !== null)) return left.priceUsd === null ? 1 : -1;
    return compare(numeric(left, 'liquidityUsd'), numeric(right, 'liquidityUsd'))
      || compare(numeric(left, 'volume24hUsd'), numeric(right, 'volume24hUsd'))
      || compare(numeric(left, 'tokenizedMarketCapUsd'), numeric(right, 'tokenizedMarketCapUsd'))
      || left.tokenName.localeCompare(right.tokenName, 'en', { sensitivity: 'base' })
      || left.mint.localeCompare(right.mint);
  });
  const selected = ranked.slice(0, Math.max(0, limit));
  const selectedMints = new Set(selected.map(record => record.mint));
  const featuredMints = new Set(featuredXstocks.map(record => record.mint));
  for (const featured of ranked.filter(record => featuredMints.has(record.mint) && !selectedMints.has(record.mint))) {
    let replaceAt = -1;
    for (let index = selected.length - 1; index >= 0; index--) {
      if (!featuredMints.has(selected[index].mint)) { replaceAt = index; break; }
    }
    if (replaceAt < 0) break;
    selectedMints.delete(selected[replaceAt].mint);
    selected[replaceAt] = featured;
    selectedMints.add(featured.mint);
  }
  return selected;
}

export async function readXstocksSolanaAssets(signal?: AbortSignal) {
  const records: XstockAsset[] = [];
  for (let page = 0; page < 10; page++) {
    const parsed = await observeProviderCall({ provider: 'XSTOCKS', operation: 'asset_registry' }, async () => {
      const timeout = AbortSignal.timeout(15000);
      let response: Response;
      try {
        response = await fetch(`${XSTOCKS_ASSETS_URL}?network=Solana&page=${page}&pageSize=100`, {
          headers: { accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store',
        });
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
        if (timeout.aborted) throw Error('xStocks public assets timed out.');
        throw error;
      }
      if (!response.ok) throw Error(`xStocks public assets HTTP ${response.status}`);
      let body: unknown;
      try { body = await response.json(); } catch { throw Error('xStocks public assets returned invalid JSON.'); }
      const result = XstockPageSchema.safeParse(body);
      if (!result.success) throw Error('xStocks public assets failed schema validation.');
      return result.data;
    });
    records.push(...parsed.nodes);
    if (!parsed.page.hasNextPage) return records;
  }
  throw Error('xStocks public assets exceeded the 10-page safety limit.');
}

export async function readJupiterStockMetadataByMint(mints: string[], signal?: AbortSignal) {
  const unique = [...new Set(mints)].slice(0, 1000);
  const records: JupiterStockToken[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const rows = await jupiterJson(`/tokens/v2/search?query=${encodeURIComponent(batch.join(','))}`, JupiterStockTokenListSchema, signal, 'global-market', 'token_metadata');
    const allowed = new Set(batch);
    records.push(...rows.filter(row => allowed.has(row.id)));
  }
  return records;
}

export async function readSolanaMintMetadata(mints: string[], signal?: AbortSignal) {
  const unique = [...new Set(mints)].slice(0, 1000);
  const connection = createConnection(signal);
  const records: SolanaMintMetadata[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100).map(mint => ({ mint, publicKey: new PublicKey(mint) }));
    const result = await connection.getMultipleAccountsInfoAndContext(batch.map(row => row.publicKey));
    const retrievedAt = new Date().toISOString();
    result.value.forEach((account, index) => {
      if (!account) return;
      try {
        const mint = unpackMint(batch[index].publicKey, account, account.owner);
        if (!mint.isInitialized) return;
        records.push(SolanaMintMetadataSchema.parse({
          mint: batch[index].mint, tokenProgram: account.owner.toBase58(), decimals: mint.decimals, retrievedAt,
        }));
      } catch {
        recordMarketEvent({ severity: 'WARN', provider: 'SOLANA_RPC', operation: 'solana_rpc', status: 'NORMALIZATION_FAILED', errorCode: 'NORMALIZATION', message: 'A Solana mint account could not be normalized.' });
      }
    });
  }
  return records;
}

export async function readJupiterMarketPrices(mints: string[], signal?: AbortSignal) {
  const unique = [...new Set(mints)].slice(0, 50);
  if (!unique.length) return new Map<string, JupiterMarketPrice>();
  const payload = await jupiterJson(`/price/v3?ids=${encodeURIComponent(unique.join(','))}`, JupiterPriceResponseSchema, signal, 'keyless-global-market', 'price_fetch');
  const retrievedAt = new Date().toISOString();
  const result = new Map<string, JupiterMarketPrice>();
  for (const mint of unique) {
    const parsed = JupiterPriceEntrySchema.safeParse(payload[mint]);
    if (parsed.success) result.set(mint, { ...parsed.data, retrievedAt });
  }
  return result;
}

export function splitPriceBatches(mints: string[]) {
  const unique = [...new Set(mints)];
  const result: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += 50) result.push(unique.slice(offset, offset + 50));
  return result;
}

function issuerUrl(symbol: string, suffix: string) {
  return `${XSTOCKS_ASSETS_URL}/${encodeURIComponent(symbol)}${suffix}`;
}

async function xstocksJson<T>(url: string, schema: z.ZodType<T>, operation: MonitoringOperation, signal?: AbortSignal): Promise<T> {
  return observeProviderCall({ provider: 'XSTOCKS', operation }, async () => {
    const timeout = AbortSignal.timeout(12_000);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: 'no-store',
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      if (timeout.aborted) throw Error('xStocks public request timed out.');
      throw error;
    }
    if (!response.ok) throw Error(`xStocks public API HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw Error('xStocks public API returned invalid JSON.'); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw Error('xStocks public response failed schema validation.');
    return parsed.data;
  });
}

export async function readXstockPrice(symbol: string, signal?: AbortSignal) {
  return { ...await xstocksJson(issuerUrl(symbol, '/price-data'), XstockPriceSchema, 'issuer_price', signal), retrievedAt: new Date().toISOString() };
}

export async function readXstockMultiplier(symbol: string, signal?: AbortSignal) {
  return { ...await xstocksJson(issuerUrl(symbol, '/multiplier?network=Solana'), XstockMultiplierSchema, 'multiplier', signal), retrievedAt: new Date().toISOString() };
}

export async function readXstockSupply(symbol: string, signal?: AbortSignal) {
  const [circulating, total] = await Promise.allSettled([
    xstocksJson(issuerUrl(symbol, '/circulating-supply?format=object'), SupplySchema, 'circulating_supply', signal),
    xstocksJson(issuerUrl(symbol, '/total-supply?format=object'), SupplySchema, 'total_supply', signal),
  ]);
  if (circulating.status === 'rejected' && total.status === 'rejected') throw circulating.reason;
  return {
    circulating: circulating.status === 'fulfilled' ? numberString(circulating.value.value) : null,
    total: total.status === 'fulfilled' ? numberString(total.value.value) : null,
    retrievedAt: new Date().toISOString(),
  };
}

export async function readXstockReserve(symbol: string, signal?: AbortSignal) {
  return { ...await xstocksJson(`https://api.xstocks.fi/api/v2/public/proof-of-reserves/${encodeURIComponent(symbol)}`, ReserveSchema, 'proof_of_reserves', signal), retrievedAt: new Date().toISOString() };
}

export async function readJupiterLendVaults(signal?: AbortSignal) {
  return jupiterJson('/lend/v1/borrow/vaults', LendVaultListSchema, signal, 'keyless-global-market', 'lend_vault_list');
}
