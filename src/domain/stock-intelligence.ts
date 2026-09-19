import { decimal } from './amounts';
import {
  StockPremiumDiscountSchema,
  type PremiumDiscountReason,
  type StockIntelligence,
  type StockMarketRecord,
} from './stocks';
import type { Portfolio } from './types';
import { byId } from '@/config/instruments';

export const JUPITER_PRICE_FRESH_MS = 2 * 60_000;

export type PremiumDiscountInput = {
  record: Pick<StockMarketRecord, 'issuerVerified' | 'mint' | 'priceUsd' | 'priceUpdatedAt'>;
  issuerMint: string | null;
  issuerPriceUsd: string | null;
  issuerCurrency: string | null;
  issuerPriceRetrievedAt: string | null;
  jupiterPriceVerified: boolean;
  multiplier: StockIntelligence['multiplier'];
  tradingHalted: boolean | null;
  sameDisplayShareUnit: boolean;
  now?: number;
};

function unavailable(reason: PremiumDiscountReason, input: PremiumDiscountInput) {
  return StockPremiumDiscountSchema.parse({
    status: 'unavailable', valuePct: null, reason, label: 'estimated',
    jupiterRetrievedAt: input.record.priceUpdatedAt,
    issuerRetrievedAt: input.issuerPriceRetrievedAt,
  });
}

/**
 * Compares one exact Solana display token with one issuer display-share quote.
 * The Token-2022 multiplier is a unit gate only: both prices are already per
 * displayed share, so multiplying either price here would apply it twice.
 */
export function estimatePremiumDiscount(input: PremiumDiscountInput) {
  if (!input.record.issuerVerified || input.issuerMint !== input.record.mint) return unavailable('issuer-unverified', input);
  if (input.record.priceUsd === null || !input.jupiterPriceVerified) return unavailable('no-jupiter-price', input);
  if (input.issuerPriceUsd === null || decimal(input.issuerPriceUsd).lte(0)) return unavailable('no-issuer-price', input);
  const now = input.now ?? Date.now();
  if (input.record.priceUpdatedAt === null || now - Date.parse(input.record.priceUpdatedAt) > JUPITER_PRICE_FRESH_MS) return unavailable('stale-jupiter-price', input);
  if (input.issuerCurrency !== 'USD') return unavailable('currency-mismatch', input);
  if (input.multiplier.status === 'pending') return unavailable('pending-multiplier', input);
  if (input.multiplier.status !== 'current' || input.multiplier.current === null || !input.sameDisplayShareUnit) return unavailable('unit-mismatch', input);
  if (input.tradingHalted !== false) return unavailable('trading-halted', input);
  const valuePct = decimal(input.record.priceUsd).minus(input.issuerPriceUsd).div(input.issuerPriceUsd).mul(100).toDecimalPlaces(8).toFixed();
  return StockPremiumDiscountSchema.parse({
    status: 'available', valuePct, reason: null, label: 'estimated',
    jupiterRetrievedAt: input.record.priceUpdatedAt,
    issuerRetrievedAt: input.issuerPriceRetrievedAt,
  });
}

/** Wallet context is derived only from the already-loaded local snapshot. */
export function localStockContext(portfolio: Portfolio | null) {
  const held = new Set<string>();
  const protectedMints = new Set<string>();
  if (!portfolio) return { held, protectedMints };
  for (const holding of portfolio.holdings) {
    const mint = byId[holding.instrumentId]?.mint;
    if (mint) held.add(mint);
  }
  for (const asset of portfolio.walletAssets || []) if (asset.verification === 'verified') held.add(asset.mint);
  for (const earn of portfolio.earnPositions || []) held.add(earn.assetMint);
  for (const loan of portfolio.loans) {
    const mint = byId[loan.collateralInstrumentId]?.mint;
    if (mint) { held.add(mint); protectedMints.add(mint); }
  }
  return { held, protectedMints };
}
