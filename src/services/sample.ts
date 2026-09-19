import { byId } from '@/config/instruments';
import { holdingsSnapshots } from '@/adapters/holdings/snapshots';
import { fromBaseUnits, scaledDisplay, toBaseUnits } from '@/domain/amounts';
import { normalizePosition } from '@/adapters/jupiter-lend/normalize';
import { referenceValue } from '@/domain/valuation';
import type { EarnPosition, Holding, MintState, Portfolio, PortfolioProvider, PriceObservation, Source } from '@/domain/types';

export const sampleSource: Source = { id: 'sample-portfolio-v1', label: 'Simulated portfolio fixture v1', url: null,
  observedAt: '2026-09-12T00:00:00.000Z', retrievedAt: '2026-09-12T00:00:00.000Z', slot: null, endSlot: null, kind: 'sample', validity: 'valid' };
export function samplePortfolio(): Portfolio {
  const owner = 'sample-owner';
  const prices: PriceObservation[] = Object.entries({ NVDAx: '125', TSLAx: '300', SPYx: '600', QQQx: '500', USDC: '1' }).map(([instrumentId,value]) => ({ instrumentId, value, currency: 'USD', basis: 'reference', per: 'display-token', multiplier: '1', source: sampleSource }));
  const makeHolding = (id: string, amount: string, scope: 'wallet' | 'deposited' = 'wallet'): Holding => {
    const instrument = byId[id]; const decimals = scope === 'wallet' ? instrument.decimals : 9;
    const raw = toBaseUnits(amount, decimals);
    const mintState: MintState = { mint: instrument.mint, decimals: instrument.decimals, tokenProgram: instrument.tokenProgram,
      multiplier: '1', pendingMultiplier: null, effectiveAt: null, chainTime: 1789171200, source: sampleSource };
    const holding: Holding = { id: `sample:${scope}:${id}`, owner, instrumentId: id, scope, accountIds: [`sample-${scope}-${id}`],
      positionId: scope === 'deposited' ? 'jupiter:80:1' : null, rawAmount: raw, rawUnit: scope === 'wallet' ? 'token-base-unit' : 'protocol-1e9', decimals,
      unscaledAmount: fromBaseUnits(raw,decimals), displayAmount: scaledDisplay(raw,decimals,'1'),
      spendable: scope === 'wallet', spendableRawAmount: scope === 'wallet' ? raw : '0',
      spendableAmount: scope === 'wallet' ? amount : '0', mintState, source: sampleSource, referenceValue: null };
    holding.referenceValue = referenceValue(holding, prices.find(p => p.instrumentId === id)); return holding;
  };
  const holdings = [makeHolding('NVDAx','14'),makeHolding('NVDAx','40','deposited'),makeHolding('SPYx','12'),makeHolding('TSLAx','5'),makeHolding('QQQx','3'),makeHolding('USDC','2000')];
  const earnPositions: EarnPosition[] = [{
    id: 'sample:earn:NVDAx', owner, receiptMint: 'sample-earn-receipt-nvdax', assetMint: byId.NVDAx.mint,
    symbol: 'NVDAx', name: 'NVIDIA xStock', decimals: byId.NVDAx.decimals,
    logoUrl: 'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png', rawUnderlying: toBaseUnits('2', byId.NVDAx.decimals),
    amount: '2', apy: '0.0412', referenceValue: { amount: '250', currency: 'USD', basis: 'reference', source: sampleSource },
    link: 'https://jup.ag/lend/earn?symbol=NVDAx', source: sampleSource,
  }];
  const loan = normalizePosition({ vaultId: 80, positionId: 1, owner, requestedOwner: owner, positionAddress: 'sample-position', positionMint: 'sample-receipt',
    supplyMint: byId.NVDAx.mint, borrowMint: byId.USDC.mint, supply1e9: '40000000000', borrow1e9: '3000000000000', vaultType: 0,
    collateralFactorPermille: '650', liquidationThresholdPermille: '750', liquidationPenaltyBps: '300', liquidatePrice1e15: '125000000000000000', isLiquidated: false, source: sampleSource });
  loan.capabilities.reason = 'Simulated loan. All quantities and protocol values are fixtures; no transaction capability.';
  return { id: 'sample-v1', mode: 'sample', owner: null, cluster: 'solana:mainnet', observedAt: sampleSource.observedAt,
    holdings, loans: [loan], prices, etfs: holdingsSnapshots(), earnPositions, unsupported: [], loanRead: 'ready',
    issues: ['QQQ is undecomposed. SPY uses dated issuer holdings and sector-allocation snapshots; portfolio quantities and all prices are simulated.'],
    capabilities: Object.fromEntries(Object.keys(byId).map(id => [id, { positionReadable: true, exposureAvailable: id !== 'QQQx', reason: 'Sample fixture, read only.' }])) };
}
export const sampleProvider: PortfolioProvider = { async read() { return { status: 'partial', data: samplePortfolio() }; } };
