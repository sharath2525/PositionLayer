import { decimal, fromBaseUnits, ratio } from '@/domain/amounts';
import { byId, verifiedVaults } from '@/config/instruments';
import { LoanSchema, type Loan, type Source } from '@/domain/types';

// Boundary uses decimal strings rather than SDK BN or JS floating-point ratios.
export type PositionInput = {
  vaultId: number; positionId: number; owner: string; requestedOwner: string;
  positionAddress: string; positionMint: string; supplyMint: string; borrowMint: string;
  supply1e9: string; borrow1e9: string; vaultType: number;
  collateralFactorPermille: string; liquidationThresholdPermille: string; liquidationPenaltyBps: string;
  liquidatePrice1e15: string | null; isLiquidated: boolean; source: Source;
};
export function normalizePosition(input: PositionInput): Loan {
  const mapping = verifiedVaults.find(v => v.vaultId === input.vaultId);
  if (!mapping || ![0,1].includes(input.vaultType)) throw Error('Unsupported vault type or ID');
  if (input.owner !== input.requestedOwner) throw Error('Position NFT owner does not match requested wallet');
  if (input.supplyMint !== byId[mapping.instrumentId].mint || input.borrowMint !== byId.USDC.mint) throw Error('Vault mint identity mismatch');
  const supply = fromBaseUnits(input.supply1e9, 9);
  const debt = fromBaseUnits(input.borrow1e9, 9);
  const threshold = decimal(input.liquidationThresholdPermille).div(1000);
  const maxBorrow = decimal(input.collateralFactorPermille).div(1000);
  if (threshold.lte(0) || threshold.gte(1) || maxBorrow.lte(0) || maxBorrow.gte(threshold)) throw Error('Invalid live vault risk parameters');
  const collateralValue = input.liquidatePrice1e15 && decimal(input.liquidatePrice1e15).gt(0)
    ? { amount: decimal(supply).mul(input.liquidatePrice1e15).div('1000000000000000').toFixed(), currency: 'USDC' as const, basis: 'protocol' as const, source: input.source } : null;
  return LoanSchema.parse({
    id: `jupiter:${input.vaultId}:${input.positionId}`, protocol: 'Jupiter Lend', vaultId: input.vaultId,
    positionId: input.positionId, owner: input.owner, positionAddress: input.positionAddress, positionMint: input.positionMint,
    collateralInstrumentId: mapping.instrumentId, debtInstrumentId: 'USDC',
    collateralAccountingRaw: input.supply1e9, debtAccountingRaw: input.borrow1e9, accountingDecimals: 9,
    collateralUnscaled: supply, debtUnscaled: debt, collateralValue,
    debtValue: { amount: debt, currency: 'USDC', basis: 'protocol', source: input.source },
    ltv: collateralValue ? ratio(debt, collateralValue.amount) : null,
    liquidationThreshold: threshold.toFixed(), maxBorrowLtv: maxBorrow.toFixed(),
    liquidationPenalty: decimal(input.liquidationPenaltyBps).div(10000).toFixed(),
    isLiquidated: input.isLiquidated, source: input.source,
    capabilities: { positionReadable: true, exposureAvailable: false,
      reason: 'Read-only normalized Jupiter Lend position.' },
  });
}
