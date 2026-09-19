import { z } from 'zod';
import { byId } from '@/config/instruments';
import { decimal, sum } from './amounts';
import { decimalString, unsignedDecimal, type EarnPosition, type Instrument, type Portfolio } from './types';

export const PortfolioLocationSchema = z.enum(['wallet', 'posted', 'earn']);
export type PortfolioLocation = z.infer<typeof PortfolioLocationSchema>;

export const StockPositionRowSchema = z.object({
  id: z.string(),
  mint: z.string(),
  symbol: z.string(),
  name: z.string(),
  logoUrl: z.string().url().regex(/^https:\/\//).nullable(),
  assetClass: z.enum(['stock', 'etf']),
  location: PortfolioLocationSchema,
  amount: unsignedDecimal.nullable(),
  referenceValueUsd: decimalString.nullable(),
  valueSourceId: z.string().nullable(),
  valueValidity: z.enum(['valid', 'stale', 'unverified']).nullable(),
});
export type StockPositionRow = z.infer<typeof StockPositionRowSchema>;

export type VerifiedStockEarnPosition = { position: EarnPosition; instrument: Instrument };

/**
 * Earn is classified only from the exact underlying mint and decimals in the
 * trusted local instrument registry. A matching symbol is deliberately ignored.
 */
export function stockIdentityForEarn(position: EarnPosition): Instrument | null {
  return Object.values(byId).find(instrument =>
    (instrument.kind === 'stock' || instrument.kind === 'etf')
    && instrument.mint === position.assetMint
    && instrument.decimals === position.decimals,
  ) || null;
}

export function verifiedStockEarnPositions(portfolio: Portfolio): VerifiedStockEarnPosition[] {
  return (portfolio.earnPositions || []).flatMap(position => {
    const instrument = stockIdentityForEarn(position);
    return instrument ? [{ position, instrument }] : [];
  });
}

function parsedRow(row: z.input<typeof StockPositionRowSchema>): StockPositionRow {
  return StockPositionRowSchema.parse(row);
}

/** A reconciled stock/ETF position list. Indexed comparison records are never rows. */
export function stockPositionRows(portfolio: Portfolio, includeEarn = true): StockPositionRow[] {
  const rows: StockPositionRow[] = [];
  for (const holding of portfolio.holdings) {
    const instrument = byId[holding.instrumentId];
    if (!instrument || (instrument.kind !== 'stock' && instrument.kind !== 'etf')) continue;
    rows.push(parsedRow({
      id: holding.id,
      mint: instrument.mint,
      symbol: instrument.symbol,
      name: instrument.name,
      logoUrl: null,
      assetClass: instrument.kind,
      location: holding.scope === 'wallet' ? 'wallet' : 'posted',
      amount: holding.displayAmount,
      referenceValueUsd: holding.referenceValue?.basis === 'reference' && holding.referenceValue.currency === 'USD' ? holding.referenceValue.amount : null,
      valueSourceId: holding.referenceValue?.source.id || null,
      valueValidity: holding.referenceValue?.source.validity || null,
    }));
  }
  for (const asset of portfolio.walletAssets || []) {
    if (!['stock', 'etf'].includes(asset.assetClass || '') || asset.verification !== 'verified' || !asset.identitySource) continue;
    rows.push(parsedRow({
      id: asset.id,
      mint: asset.mint,
      symbol: asset.symbol,
      name: asset.name,
      logoUrl: asset.logoUrl || null,
      assetClass: asset.assetClass as 'stock' | 'etf',
      location: 'wallet',
      amount: asset.amount,
      referenceValueUsd: asset.referenceValue?.basis === 'reference' && asset.referenceValue.currency === 'USD' ? asset.referenceValue.amount : null,
      valueSourceId: asset.referenceValue?.source.id || null,
      valueValidity: asset.referenceValue?.source.validity || null,
    }));
  }
  if (includeEarn) for (const { position, instrument } of verifiedStockEarnPositions(portfolio)) {
    rows.push(parsedRow({
      id: position.id,
      mint: instrument.mint,
      symbol: instrument.symbol,
      name: instrument.name,
      logoUrl: position.logoUrl || null,
      assetClass: instrument.kind as 'stock' | 'etf',
      location: 'earn',
      amount: position.amount,
      referenceValueUsd: position.referenceValue?.basis === 'reference' && position.referenceValue.currency === 'USD' ? position.referenceValue.amount : null,
      valueSourceId: position.referenceValue?.source.id || null,
      valueValidity: position.referenceValue?.source.validity || null,
    }));
  }
  return rows;
}

export function importantStockPositions(portfolio: Portfolio, limit = 5): StockPositionRow[] {
  return stockPositionRows(portfolio, false).sort((left, right) => {
    if (left.referenceValueUsd !== null && right.referenceValueUsd !== null) return decimal(right.referenceValueUsd).comparedTo(left.referenceValueUsd);
    if (left.referenceValueUsd !== null) return -1;
    if (right.referenceValueUsd !== null) return 1;
    return left.symbol.localeCompare(right.symbol);
  }).slice(0, Math.max(0, limit));
}

export function portfolioStockReferenceTotal(portfolio: Portfolio): string {
  return sum(stockPositionRows(portfolio).flatMap(row => row.referenceValueUsd === null ? [] : [row.referenceValueUsd]));
}
