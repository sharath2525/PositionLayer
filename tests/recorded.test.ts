import { describe,it,expect } from 'vitest';
import { byId } from '@/config/instruments';
import { samplePortfolio } from '@/services/sample';
import { normalizePosition } from '@/adapters/jupiter-lend/normalize';
import { PortfolioResultSchema } from '@/domain/types';
import { isSnapshotStale } from '@/domain/freshness';

// Local RPC captures are deliberately excluded from the public repository.
describe('synthetic portfolio accounting and freshness',()=>{
  it('normalizes protocol units and risk parameters without treating USDC as USD',()=>{
    const at='2026-09-12T00:00:00.000Z';
    const loan=normalizePosition({vaultId:77,positionId:1,owner:'synthetic-owner',requestedOwner:'synthetic-owner',positionAddress:'synthetic-position',positionMint:'synthetic-position-mint',
      supplyMint:byId.TSLAx.mint,borrowMint:byId.USDC.mint,supply1e9:'40000000000',borrow1e9:'10000000000',vaultType:0,
      collateralFactorPermille:'650',liquidationThresholdPermille:'750',liquidationPenaltyBps:'500',
      liquidatePrice1e15:'500000000000000',isLiquidated:false,source:{id:'synthetic-account',label:'Synthetic protocol fixture',url:null,observedAt:at,retrievedAt:at,slot:null,endSlot:null,kind:'live',validity:'valid'}});
    expect(loan.collateralUnscaled).toBe('40');expect(loan.debtUnscaled).toBe('10');
    expect(loan.collateralValue?.amount).toBe('20');expect(loan.collateralValue?.currency).toBe('USDC');
    expect(loan.ltv).toBe('0.5');expect(loan.maxBorrowLtv).toBe('0.65');expect(loan.liquidationThreshold).toBe('0.75');
  });
  it('validates a normalized response and detects aging',()=>{
    const portfolio=samplePortfolio();portfolio.mode='live';
    const result=PortfolioResultSchema.parse({status:'ready',data:portfolio});if(result.status==='error')throw Error('Expected validated fixture');
    expect(result.data.loans.length).toBeGreaterThan(0);expect(result.data.mode).toBe('live');
    expect(isSnapshotStale(result.data,Date.parse(result.data.observedAt)+120001)).toBe(true);
  });
});
