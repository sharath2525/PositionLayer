import { z } from 'zod';
import { verifiedVaults } from '@/config/instruments';
import { decimal, ratio } from './amounts';
import { identityIssues, sourceState, type ReadContext } from './guards';
import { decimalString, type Loan, type Portfolio } from './types';

export const LoanRiskStateSchema = z.enum([
  'no-debt',
  'within-borrow-range',
  'above-borrow-limit',
  'threshold-reached',
  'unavailable',
]);

export const LoanRiskMeterSchema = z.object({
  loanId: z.string(),
  currentLtv: decimalString.nullable(),
  maxBorrowLtv: decimalString,
  liquidationThreshold: decimalString,
  liquidationPenalty: decimalString,
  liquidationBoundaryUsed: decimalString.nullable(),
  collateralDeclineToLiquidation: decimalString.nullable(),
  healthFactor: decimalString.nullable(),
  state: LoanRiskStateSchema,
  stressedLtv: decimalString.nullable(),
  stressedBoundaryUsed: decimalString.nullable(),
  stressedThresholdCrossed: z.boolean().nullable(),
  observedAt: z.string().datetime(),
  freshness: z.enum(['fresh', 'sample', 'stale', 'unverified']),
  sourceIds: z.array(z.string()),
  assumptions: z.array(z.string()),
  blockers: z.array(z.string()),
});

export type LoanRiskState = z.infer<typeof LoanRiskStateSchema>;
export type LoanRiskMeter = z.infer<typeof LoanRiskMeterSchema>;

function unavailable(
  loan: Loan,
  freshness: LoanRiskMeter['freshness'],
  sourceIds: string[],
  assumptions: string[],
  blockers: string[],
): LoanRiskMeter {
  return LoanRiskMeterSchema.parse({
    loanId: loan.id,
    currentLtv: null,
    maxBorrowLtv: loan.maxBorrowLtv,
    liquidationThreshold: loan.liquidationThreshold,
    liquidationPenalty: loan.liquidationPenalty,
    liquidationBoundaryUsed: null,
    collateralDeclineToLiquidation: null,
    healthFactor: null,
    state: 'unavailable',
    stressedLtv: null,
    stressedBoundaryUsed: null,
    stressedThresholdCrossed: null,
    observedAt: loan.source.observedAt,
    freshness,
    sourceIds,
    assumptions,
    blockers: [...new Set(blockers)],
  });
}

/** Pure protocol-risk calculation. Reference USD prices and executable quotes are never inputs. */
export function loanRiskMeter(
  portfolio: Portfolio,
  loan: Loan,
  context: ReadContext,
  stressedCollateral?: string | null,
): LoanRiskMeter {
  const sources = [loan.source, ...(loan.collateralValue ? [loan.collateralValue.source] : []), ...(loan.debtValue ? [loan.debtValue.source] : [])];
  const sourceIds = [...new Set(sources.map(source => source.id))];
  const states = sources.map(source => sourceState(source, portfolio.mode, context.now));
  const freshness: LoanRiskMeter['freshness'] = states.includes('unverified') ? 'unverified' : states.includes('stale') ? 'stale' : states.includes('sample') ? 'sample' : 'fresh';
  const blockers = identityIssues(portfolio, context);
  const assumptions = [
    'Accrued protocol USDC debt is held fixed at the observed snapshot.',
    'Protocol-oracle collateral value is kept separate from reference USD prices and hypothetical scenarios.',
    'The meter normalizes LTV against the liquidation threshold; it is not a weighted risk score.',
  ];

  const registered = verifiedVaults.some(entry => entry.vaultId === loan.vaultId && entry.instrumentId === loan.collateralInstrumentId);
  if (!registered || loan.debtInstrumentId !== 'USDC' || !loan.capabilities.positionReadable || loan.isLiquidated) {
    blockers.push('Position is unsupported, unreadable, or already liquidated.');
  }
  if (freshness === 'stale' || freshness === 'unverified') blockers.push('Protocol risk source is stale, future-dated, or unverified. Refresh the position.');

  let boundariesValid = false;
  try {
    const borrow = decimal(loan.maxBorrowLtv);
    const threshold = decimal(loan.liquidationThreshold);
    boundariesValid = borrow.gt(0) && threshold.gt(0) && borrow.lt(threshold) && threshold.lt(1);
  } catch { /* reported below */ }
  if (!boundariesValid) blockers.push('Vault boundaries are invalid: require 0 < maximum-borrow LTV < liquidation threshold < 100%.');

  const collateral = loan.collateralValue;
  const debt = loan.debtValue;
  let basisValid = false;
  try {
    basisValid = collateral?.basis === 'protocol' && collateral.currency === 'USDC' && decimal(collateral.amount).gt(0)
      && debt?.basis === 'protocol' && debt.currency === 'USDC' && decimal(debt.amount).gte(0)
      && decimal(debt.amount).eq(loan.debtUnscaled);
  } catch { /* reported below */ }
  if (!basisValid) blockers.push('Compatible positive protocol collateral and matching accrued USDC debt are required.');

  let currentLtv: string | null = null;
  if (basisValid) currentLtv = ratio(debt!.amount, collateral!.amount);
  if (currentLtv !== null && loan.ltv !== null) {
    try { if (!decimal(currentLtv).eq(loan.ltv)) blockers.push('Stored LTV does not match the protocol debt and collateral values.'); }
    catch { blockers.push('Stored LTV is invalid.'); }
  }
  if (blockers.length || currentLtv === null) return unavailable(loan, freshness, sourceIds, assumptions, blockers);

  const threshold = decimal(loan.liquidationThreshold);
  const borrow = decimal(loan.maxBorrowLtv);
  const ltv = decimal(currentLtv);
  const noDebt = ltv.eq(0);
  const liquidationBoundaryUsed = ltv.div(threshold).toFixed();
  const collateralDeclineToLiquidation = decimal('1').sub(liquidationBoundaryUsed).toFixed();
  const state: LoanRiskState = noDebt ? 'no-debt' : ltv.lt(borrow) ? 'within-borrow-range' : ltv.lt(threshold) ? 'above-borrow-limit' : 'threshold-reached';

  let stressedLtv: string | null = null;
  let stressedBoundaryUsed: string | null = null;
  let stressedThresholdCrossed: boolean | null = null;
  if (stressedCollateral !== undefined && stressedCollateral !== null) {
    try {
      if (decimal(stressedCollateral).gt(0)) {
        stressedLtv = ratio(debt!.amount, stressedCollateral);
        stressedBoundaryUsed = stressedLtv === null ? null : decimal(stressedLtv).div(threshold).toFixed();
        stressedThresholdCrossed = stressedLtv === null ? null : decimal(stressedLtv).gte(threshold);
      }
    } catch { /* scenario engine owns its blocker text */ }
  }

  return LoanRiskMeterSchema.parse({
    loanId: loan.id,
    currentLtv,
    maxBorrowLtv: loan.maxBorrowLtv,
    liquidationThreshold: loan.liquidationThreshold,
    liquidationPenalty: loan.liquidationPenalty,
    liquidationBoundaryUsed,
    collateralDeclineToLiquidation,
    healthFactor: noDebt ? null : threshold.div(ltv).toFixed(),
    state,
    stressedLtv,
    stressedBoundaryUsed,
    stressedThresholdCrossed,
    observedAt: loan.source.observedAt,
    freshness,
    sourceIds,
    assumptions,
    blockers: [],
  });
}

/** Selects by the same transparent liquidation-boundary usage shown in the meter. */
export function highestRiskLoan(portfolio: Portfolio, context: ReadContext) {
  const rows = portfolio.loans.map(loan => ({ loan, risk: loanRiskMeter(portfolio, loan, context) }));
  const ranked = rows.filter(row => row.risk.liquidationBoundaryUsed !== null).sort((left, right) =>
    decimal(right.risk.liquidationBoundaryUsed!).comparedTo(left.risk.liquidationBoundaryUsed!),
  );
  return ranked[0] || rows[0] || null;
}
