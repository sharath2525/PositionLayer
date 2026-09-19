import 'server-only';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { byId, VAULT_PROGRAM, verifiedVaults } from '@/config/instruments';
import { decimal, fromBaseUnits, ratio, toBaseUnits } from '@/domain/amounts';
import type { IndexedPosition, Loan, PriceObservation, Source, UnmodeledLoan, WalletAsset, EarnPosition } from '@/domain/types';
import type { TokenAccount, WalletAmountState } from '@/adapters/solana/accounts';
import type { XstockIdentity } from '@/adapters/xstocks/assets';
import { jupiterJson } from './client';
import { recordMarketEvent } from '@/services/monitoring/log-manager';

const IsoTimestampSchema = z.string().refine(
  value => Number.isFinite(Date.parse(value)),
  'Expected an ISO-8601 timestamp',
);
const ApiTokenSchema = z.object({
  address: z.string(), name: z.string(), symbol: z.string(), uiSymbol: z.string().optional(), decimals: z.number().int().nonnegative(),
  price: z.string().optional(), updatedAt: IsoTimestampSchema.optional(), icon: z.string().url().regex(/^https:\/\//).nullable().optional(),
});
const VaultSchema = z.object({
  id: z.number().int(), address: z.string(), type: z.number().int(), supplyToken: ApiTokenSchema, borrowToken: ApiTokenSchema,
  collateralFactor: z.string(), liquidationThreshold: z.string(), liquidationPenalty: z.string().optional(),
  oraclePriceLiquidate: z.string().optional(), oracleTimestamp: z.union([z.number(), z.string()]).optional(),
}).passthrough();
const BorrowPositionSchema = z.object({
  id: z.number().int(), vaultId: z.number().int(), address: z.string(), supply: z.string().regex(/^\d+$/),
  borrow: z.string().regex(/^\d+$/), dustBorrow: z.string().regex(/^\d+$/), isLiquidated: z.boolean(),
  ownerAddress: z.string(), vault: VaultSchema,
}).passthrough();
const BorrowPositionsSchema = z.array(BorrowPositionSchema);
const EarnTokenSchema = z.object({
  id: z.number().int(), address: z.string(), symbol: z.string(), uiSymbol: z.string().optional(), decimals: z.number().int().nonnegative(),
  assetAddress: z.string(), asset: ApiTokenSchema, totalRate: z.string().optional(),
}).passthrough();
const EarnPositionApiSchema = z.object({ token: EarnTokenSchema, ownerAddress: z.string(), shares: z.string().regex(/^\d+$/), underlyingAssets: z.string().regex(/^\d+$/) }).passthrough();
const EarnPositionsSchema = z.array(EarnPositionApiSchema);
const PortfolioElementSchema = z.object({
  type: z.string(), label: z.string(), platformId: z.string(), name: z.string().optional(), value: z.number().finite(), netApy: z.number().finite().optional(), data: z.unknown(),
}).passthrough();
const PortfolioApiSchema = z.object({ date: z.number().int(), owner: z.string(), elements: z.array(PortfolioElementSchema) }).passthrough();
const TokenMetadataSchema = z.object({
  id: z.string(), name: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative(), tokenProgram: z.string(),
  icon: z.string().url().regex(/^https:\/\//).nullable().optional(), isVerified: z.boolean().nullable().optional(), tags: z.array(z.string()).nullable().optional(),
  usdPrice: z.number().finite().positive().nullable().optional(), updatedAt: IsoTimestampSchema.optional(),
  audit: z.object({ isSus: z.boolean().optional() }).passthrough().nullable().optional(),
}).passthrough();
const TokenMetadataListSchema = z.array(TokenMetadataSchema);
const PriceEntrySchema = z.object({ usdPrice: z.number().finite().positive(), blockId: z.number().int().nonnegative(), decimals: z.number().int().nonnegative() }).passthrough();
const PriceResponseSchema = z.record(z.string(), z.unknown());

type ApiBorrowPosition = z.infer<typeof BorrowPositionSchema>;
type ApiEarnPosition = z.infer<typeof EarnPositionApiSchema>;
export type JupiterTokenMetadata = z.infer<typeof TokenMetadataSchema>;

function decimalNumber(value: number): string { return decimal(String(value)).toFixed(); }
function apiTimestamp(value: number | string | undefined, fallback: string): string {
  const normalizedFallback = new Date(fallback).toISOString();
  if (value === undefined) return normalizedFallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return normalizedFallback;
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
}
function validity(observedAt: string): Source['validity'] { return Date.now() - Date.parse(observedAt) > 120000 ? 'stale' : 'valid'; }
function positionPda(vaultId: number, positionId: number): string {
  const vaultSeed = Buffer.alloc(2); vaultSeed.writeUInt16LE(vaultId);
  const positionSeed = Buffer.alloc(4); positionSeed.writeUInt32LE(positionId);
  return PublicKey.findProgramAddressSync([Buffer.from('position'), vaultSeed, positionSeed], new PublicKey(VAULT_PROGRAM))[0].toBase58();
}
function positionLink(position: ApiBorrowPosition) { return `https://jup.ag/lend/borrow/${position.vaultId}/nfts/${position.id}`; }
function positionSource(position: ApiBorrowPosition, retrievedAt: string): Source {
  const observedAt = apiTimestamp(position.vault.oracleTimestamp, position.vault.supplyToken.updatedAt || retrievedAt);
  return { id: `jupiter-borrow-api:${position.vaultId}:${position.id}:${observedAt}`, label: 'Jupiter Lend Borrow API', url: positionLink(position),
    observedAt, retrievedAt, slot: null, endSlot: null, kind: 'live', validity: validity(observedAt) };
}

export function normalizeBorrowPosition(input: unknown, owner: string, retrievedAt = new Date().toISOString()): Loan | UnmodeledLoan {
  const position: ApiBorrowPosition = BorrowPositionSchema.parse(input);
  if (position.ownerAddress !== owner || position.vaultId !== position.vault.id) throw Error('Jupiter borrow position identity mismatch');
  const source = positionSource(position, retrievedAt);
  const collateral = fromBaseUnits(position.supply, position.vault.supplyToken.decimals);
  const debt = fromBaseUnits(position.borrow, position.vault.borrowToken.decimals);
  const mapping = verifiedVaults.find(v => v.vaultId === position.vaultId);
  const registered = mapping && byId[mapping.instrumentId];
  const usdc = byId.USDC;
  const collateralUsd = position.vault.supplyToken.price ? decimal(collateral).mul(position.vault.supplyToken.price).toFixed() : null;
  const debtUsd = position.vault.borrowToken.price ? decimal(debt).mul(position.vault.borrowToken.price).toFixed() : null;
  if (!registered || registered.mint !== position.vault.supplyToken.address || registered.decimals !== position.vault.supplyToken.decimals ||
      usdc.mint !== position.vault.borrowToken.address || usdc.decimals !== position.vault.borrowToken.decimals || position.vault.type !== 0) {
    return { id: `jupiter-unmodeled:${position.vaultId}:${position.id}`, owner, vaultId: position.vaultId, positionId: position.id,
      collateralMint: position.vault.supplyToken.address,
      collateralSymbol: position.vault.supplyToken.uiSymbol || position.vault.supplyToken.symbol,
      collateralName: position.vault.supplyToken.name, collateralLogoUrl: position.vault.supplyToken.icon || null,
      debtMint: position.vault.borrowToken.address,
      debtSymbol: position.vault.borrowToken.uiSymbol || position.vault.borrowToken.symbol,
      debtName: position.vault.borrowToken.name, debtLogoUrl: position.vault.borrowToken.icon || null,
      collateralAmount: collateral, debtAmount: debt,
      collateralValueUsd: collateralUsd, debtValueUsd: debtUsd,
      liquidationThreshold: /^\d+$/.test(position.vault.liquidationThreshold) ? decimal(position.vault.liquidationThreshold).div(1000).toFixed() : null,
      reason: 'Visible through Jupiter; risk and stress calculations require a verified local vault/mint mapping.', link: positionLink(position), source };
  }
  const threshold = decimal(position.vault.liquidationThreshold).div(1000);
  const maxBorrow = decimal(position.vault.collateralFactor).div(1000);
  if (threshold.lte(0) || threshold.gte(1) || maxBorrow.lte(0) || maxBorrow.gte(threshold)) throw Error('Invalid Jupiter vault risk parameters');
  const oracle = position.vault.oraclePriceLiquidate && /^\d+$/.test(position.vault.oraclePriceLiquidate) ? position.vault.oraclePriceLiquidate : null;
  const collateralValue = oracle ? { amount: decimal(collateral).mul(oracle).div('1000000000000000').toFixed(), currency: 'USDC' as const, basis: 'protocol' as const, source } : null;
  const debtValue = { amount: debt, currency: 'USDC' as const, basis: 'protocol' as const, source };
  return {
    id: `jupiter:${position.vaultId}:${position.id}`, protocol: 'Jupiter Lend', vaultId: position.vaultId, positionId: position.id,
    owner, positionAddress: positionPda(position.vaultId, position.id), positionMint: position.address,
    collateralInstrumentId: registered.id, debtInstrumentId: 'USDC',
    collateralAccountingRaw: toBaseUnits(collateral, 9), debtAccountingRaw: toBaseUnits(debt, 9), accountingDecimals: 9,
    collateralUnscaled: collateral, debtUnscaled: debt, collateralValue, debtValue,
    ltv: collateralValue ? ratio(debt, collateralValue.amount) : null, liquidationThreshold: threshold.toFixed(), maxBorrowLtv: maxBorrow.toFixed(),
    liquidationPenalty: decimal(position.vault.liquidationPenalty || '0').div(10000).toFixed(), isLiquidated: position.isLiquidated, source,
    capabilities: { positionReadable: true, exposureAvailable: false,
      reason: 'Read through Jupiter’s live Borrow API. This position is outside the verified local risk registry.' },
  };
}

function earnSource(position: ApiEarnPosition, retrievedAt: string): Source {
  const observedAt = new Date(position.token.asset.updatedAt || retrievedAt).toISOString();
  return { id: `jupiter-earn-api:${position.token.id}:${observedAt}`, label: 'Jupiter Lend Earn API', url: `https://jup.ag/lend/earn?symbol=${encodeURIComponent(position.token.asset.uiSymbol || position.token.asset.symbol)}`,
    observedAt, retrievedAt, slot: null, endSlot: null, kind: 'live', validity: validity(observedAt) };
}
export function normalizeEarnPosition(input: unknown, owner: string, retrievedAt = new Date().toISOString()): EarnPosition | null {
  const position: ApiEarnPosition = EarnPositionApiSchema.parse(input);
  if (position.ownerAddress !== owner) throw Error('Jupiter earn position identity mismatch');
  if (BigInt(position.underlyingAssets) === 0n) return null;
  const source = earnSource(position, retrievedAt);
  const amount = fromBaseUnits(position.underlyingAssets, position.token.asset.decimals);
  const value = position.token.asset.price ? decimal(amount).mul(position.token.asset.price).toFixed() : null;
  return { id: `jupiter-earn:${position.token.id}`, owner, receiptMint: position.token.address, assetMint: position.token.assetAddress,
    symbol: position.token.asset.uiSymbol || position.token.asset.symbol, name: position.token.asset.name, decimals: position.token.asset.decimals,
    logoUrl: position.token.asset.icon || null,
    rawUnderlying: position.underlyingAssets, amount, apy: position.token.totalRate && /^\d+$/.test(position.token.totalRate) ? decimal(position.token.totalRate).div(10000).toFixed() : null,
    referenceValue: value === null ? null : { amount: value, currency: 'USD', basis: 'reference', source }, link: source.url!, source };
}

function extractLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const link = (data as { link?: unknown }).link;
  return typeof link === 'string' && /^https:\/\//.test(link) ? link : null;
}
export async function readJupiterAccount(owner: string, signal?: AbortSignal) {
  const retrievedAt = new Date().toISOString();
  const issues: string[] = [];
  const [borrowResult, earnResult, portfolioResult] = await Promise.allSettled([
    jupiterJson(`/lend/v1/borrow/positions?users=${encodeURIComponent(owner)}`, BorrowPositionsSchema, signal, 'wallet-specific', 'borrow_positions'),
    jupiterJson(`/lend/v1/earn/positions?users=${encodeURIComponent(owner)}`, EarnPositionsSchema, signal, 'wallet-specific', 'earn_positions'),
    jupiterJson(`/portfolio/v1/positions/${encodeURIComponent(owner)}`, PortfolioApiSchema, signal, 'wallet-specific', 'portfolio_positions'),
  ]);
  const loans: Loan[] = []; const unmodeledLoans: UnmodeledLoan[] = []; const receiptMints = new Set<string>();
  if (borrowResult.status === 'fulfilled') for (const position of borrowResult.value) {
    receiptMints.add(position.address);
    try { const normalized = normalizeBorrowPosition(position, owner, retrievedAt); if ('protocol' in normalized) loans.push(normalized); else unmodeledLoans.push(normalized); }
    catch (error) {
      recordMarketEvent({ severity: 'ERROR', provider: 'JUPITER', operation: 'borrow_positions', status: 'NORMALIZATION_FAILED', errorCode: 'NORMALIZATION', message: 'A Jupiter borrow position failed local normalization.' });
      issues.push(`Jupiter borrow ${position.vaultId}/${position.id}: ${error instanceof Error ? error.message : 'normalization failed'}`);
    }
  } else issues.push(`Jupiter Borrow API unavailable: ${borrowResult.reason instanceof Error ? borrowResult.reason.message : 'request failed'}`);
  const earnPositions: EarnPosition[] = [];
  if (earnResult.status === 'fulfilled') for (const position of earnResult.value) {
    receiptMints.add(position.token.address);
    try { const normalized = normalizeEarnPosition(position, owner, retrievedAt); if (normalized) earnPositions.push(normalized); }
    catch (error) {
      recordMarketEvent({ severity: 'ERROR', provider: 'JUPITER', operation: 'earn_positions', status: 'NORMALIZATION_FAILED', errorCode: 'NORMALIZATION', message: 'A Jupiter Earn position failed local normalization.' });
      issues.push(`Jupiter Earn ${position.token.id}: ${error instanceof Error ? error.message : 'normalization failed'}`);
    }
  } else issues.push(`Jupiter Earn API unavailable: ${earnResult.reason instanceof Error ? earnResult.reason.message : 'request failed'}`);
  const indexedPositions: IndexedPosition[] = [];
  if (portfolioResult.status === 'fulfilled') {
    if (portfolioResult.value.owner !== owner) issues.push('Jupiter Portfolio API owner mismatch; indexed positions excluded.');
    else {
      const observedAt = new Date(portfolioResult.value.date).toISOString();
      const source: Source = { id: `jupiter-portfolio:${owner}:${portfolioResult.value.date}`, label: 'Jupiter Portfolio API', url: `https://jup.ag/portfolio/${owner}`,
        observedAt, retrievedAt, slot: null, endSlot: null, kind: 'live', validity: validity(observedAt) };
      portfolioResult.value.elements.forEach((element, index) => indexedPositions.push({ id: `jupiter-index:${element.platformId}:${element.type}:${index}`,
        type: element.type, platformId: element.platformId, label: element.label, name: element.name || null,
        valueUsd: decimalNumber(element.value), netApy: element.netApy === undefined ? null : decimalNumber(element.netApy), link: extractLink(element.data), source }));
    }
  } else issues.push(`Jupiter Portfolio API unavailable: ${portfolioResult.reason instanceof Error ? portfolioResult.reason.message : 'request failed'}`);
  return { loans, unmodeledLoans, earnPositions, indexedPositions, receiptMints, issues,
    status: borrowResult.status === 'fulfilled' ? 'ready' as const : loans.length ? 'partial' as const : 'blocked' as const };
}

export async function readTokenMetadata(mints: string[], signal?: AbortSignal): Promise<Map<string, JupiterTokenMetadata>> {
  const unique = [...new Set(mints)].slice(0, 100);
  if (!unique.length) return new Map();
  const rows = await jupiterJson(`/tokens/v2/search?query=${encodeURIComponent(unique.join(','))}`, TokenMetadataListSchema, signal, 'generic', 'wallet_token_metadata');
  return new Map(rows.filter(row => unique.includes(row.id)).map(row => [row.id, row]));
}

export function parseJupiterPriceEntry(value: unknown) { const parsed = PriceEntrySchema.safeParse(value); return parsed.success ? parsed.data : null; }
export async function readJupiterPrices(requests: { instrumentId: string; mint: string; decimals: number }[], metadata: Map<string, JupiterTokenMetadata>, signal?: AbortSignal) {
  const selected = [...new Map(requests.map(request => [request.mint, request])).values()].slice(0, 50);
  if (!selected.length) return { prices: [] as PriceObservation[], byMint: new Map<string, PriceObservation>(), issues: [] as string[] };
  const payload = await jupiterJson(`/price/v3?ids=${encodeURIComponent(selected.map(row => row.mint).join(','))}`, PriceResponseSchema, signal, 'generic', 'wallet_price_fetch');
  const retrievedAt = new Date().toISOString();
  const rows: { request: (typeof selected)[number]; value: string; blockId: number | null; observedAt: string; label: string; url: string }[] = [];
  const issues: string[] = [];
  let unavailableWalletPrices = 0;
  for (const request of selected) {
    const price = parseJupiterPriceEntry(payload[request.mint]);
    const token = metadata.get(request.mint);
    const timestamp = token?.updatedAt ? new Date(token.updatedAt).toISOString() : null;
    if (price && price.decimals === request.decimals && timestamp) {
      rows.push({ request, value: decimalNumber(price.usdPrice), blockId: price.blockId, observedAt: timestamp,
        label: 'Jupiter Price API V3 · Tokens timestamp', url: 'https://developers.jup.ag/docs/price' });
    } else if (token?.usdPrice && token.decimals === request.decimals && timestamp) {
      rows.push({ request, value: decimalNumber(token.usdPrice), blockId: null, observedAt: timestamp,
        label: 'Jupiter Tokens API V2 price', url: 'https://developers.jup.ag/docs/tokens' });
    } else if (request.instrumentId.startsWith('mint:')) unavailableWalletPrices++;
    else issues.push(`${request.instrumentId}: Jupiter did not return a price with matching mint decimals and a publication timestamp; reference value unavailable.`);
  }
  if (unavailableWalletPrices) issues.push(`${unavailableWalletPrices} other wallet asset${unavailableWalletPrices===1?' has':'s have'} no complete Jupiter price observation; those reference values are unavailable.`);
  if (!rows.length) return { prices: [] as PriceObservation[], byMint: new Map<string, PriceObservation>(), issues };
  const prices: PriceObservation[] = [];
  for (const row of rows) {
    const { request } = row;
    prices.push({ instrumentId: request.instrumentId, value: row.value, currency: 'USD', basis: 'reference', per: 'unscaled-token', multiplier: null,
      source: { id: `jupiter-price:${request.mint}:${row.blockId ?? row.observedAt}`, label: row.label, url: row.url, observedAt: row.observedAt, retrievedAt,
        slot: null, endSlot: null, kind: 'live', validity: validity(row.observedAt) } });
  }
  if (prices.some(price => price.source.validity === 'stale')) {
    issues.push('Some Jupiter price publication timestamps are older than the 2-minute reference-price policy. Their dated values remain visible and are excluded from fresh-value decisions.');
  }
  return { prices, byMint: new Map(prices.map(price => [selected.find(row => row.instrumentId === price.instrumentId)!.mint, price])), issues };
}

export function normalizeOtherWalletAssets(accounts: TokenAccount[], owner: string, metadata: Map<string, JupiterTokenMetadata>, priceByMint: Map<string, PriceObservation>, source: Source, excludedMints: Set<string>,
  amountByMint = new Map<string, WalletAmountState>(), xstocks = new Map<string, XstockIdentity>()): { assets: WalletAsset[]; unsupported: { mint: string; accountCount: number; reason: string }[] } {
  const registered = new Set(Object.values(byId).map(instrument => instrument.mint));
  const groups = new Map<string, TokenAccount[]>();
  for (const account of accounts) if (BigInt(account.raw) > 0n && !registered.has(account.mint) && !excludedMints.has(account.mint)) {
    const group = groups.get(account.mint) || []; group.push(account); groups.set(account.mint, group);
  }
  const assets: WalletAsset[] = []; const unsupported: { mint: string; accountCount: number; reason: string }[] = [];
  for (const [mint, group] of groups) {
    const token = metadata.get(mint);
    if (!token || group.some(account => account.tokenProgram !== token.tokenProgram)) { unsupported.push({ mint, accountCount: group.length, reason: 'Jupiter token metadata or token-program identity was unavailable.' }); continue; }
    const raw = group.reduce((sum, account) => sum + BigInt(account.raw), 0n).toString();
    const resolved = amountByMint.get(mint);
    const amount = resolved?.amount ?? null;
    const spendable = resolved?.spendableAmount ?? null;
    const suspicious = token.audit?.isSus === true || token.tags?.includes('banned') === true;
    const price = priceByMint.get(mint);
    const value = resolved && token.isVerified === true && !suspicious && price ? {
      amount: decimal(resolved.unscaledAmount).mul(price.value).toFixed(), currency: 'USD' as const, basis: 'reference' as const, source: price.source,
    } : null;
    const stock = xstocks.get(mint);
    assets.push({ id: `wallet-asset:${mint}`, owner, mint, symbol: stock?.symbol || token.symbol, name: stock?.name || token.name, tokenProgram: token.tokenProgram,
      decimals: token.decimals, accountCount: group.length, rawAmount: raw, unscaledAmount: resolved?.unscaledAmount ?? null, amount, spendableAmount: spendable,
      verification: suspicious ? 'suspicious' : token.isVerified ? 'verified' : 'unverified', assetClass: stock?.assetClass || 'other',
      companyId: stock?.companyId || null, sector: stock?.sector || null, securityId: stock?.securityId || null,
      identitySource: stock?.identitySource || null, underlyingSymbol: stock?.underlyingSymbol || null, logoUrl: stock?.logoUrl || token.icon || null,
      amountConvention: resolved?.convention || 'unresolved', referenceValue: value, source });
  }
  return { assets, unsupported };
}
