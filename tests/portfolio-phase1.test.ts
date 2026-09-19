import { describe, expect, it } from 'vitest';
import { exposure } from '@/domain/exposure';
import { highestRiskLoan } from '@/domain/loan-risk';
import { importantStockPositions, portfolioStockReferenceTotal, stockIdentityForEarn, stockPositionRows, verifiedStockEarnPositions } from '@/domain/portfolio';
import { byId } from '@/config/instruments';
import { samplePortfolio } from '@/services/sample';
import { summary } from '@/domain/valuation';

describe('Phase 1 portfolio separation and reconciliation',()=>{
  it('classifies Earn stocks only by exact trusted underlying mint and decimals',()=>{
    const portfolio=samplePortfolio();
    const position=portfolio.earnPositions![0];
    expect(stockIdentityForEarn(position)?.id).toBe('NVDAx');
    expect(stockIdentityForEarn({...position,assetMint:'same-symbol-wrong-mint'})).toBeNull();
    expect(stockIdentityForEarn({...position,decimals:6})).toBeNull();
    expect(verifiedStockEarnPositions(portfolio).map(row=>row.instrument.id)).toEqual(['NVDAx']);
  });

  it('keeps wallet, posted, and Earn routes distinct and reconciled with Exposure',()=>{
    const portfolio=samplePortfolio();
    const rows=stockPositionRows(portfolio);
    const nvda=rows.filter(row=>row.symbol==='NVDAx');
    expect(nvda.map(row=>row.location).sort()).toEqual(['earn','posted','wallet']);
    expect(portfolioStockReferenceTotal(portfolio)).toBe('17200');
    expect(exposure(portfolio).valuedStockUsd).toBe(portfolioStockReferenceTotal(portfolio));
    expect(exposure(portfolio).companies.find(row=>row.id==='NVIDIA')?.contributions.map(row=>row.scope)).toEqual(expect.arrayContaining(['wallet','deposited','earn']));
  });

  it('does not promote a symbol-spoofed Earn record into stock totals',()=>{
    const portfolio=samplePortfolio();
    const original=portfolio.earnPositions![0];
    portfolio.earnPositions=[{...original,id:'spoofed',assetMint:byId.USDC.mint,symbol:'NVDAx',decimals:byId.USDC.decimals}];
    expect(verifiedStockEarnPositions(portfolio)).toHaveLength(0);
    expect(exposure(portfolio).valuedStockUsd).toBe('16950');
  });

  it('keeps an unverified wallet asset outside covered totals even if input carries a value',()=>{
    const portfolio=samplePortfolio();
    const source=portfolio.prices[0].source;
    portfolio.walletAssets=[{
      id:'unverified-valued-input',owner:portfolio.holdings[0].owner,mint:'untrusted-mint',symbol:'NVDAx',name:'Spoofed NVIDIA',
      tokenProgram:'untrusted-program',decimals:8,accountCount:1,rawAmount:'100000000',unscaledAmount:'1',amount:'1',spendableAmount:'1',
      verification:'unverified',assetClass:'stock',companyId:'NVIDIA',sector:'Information Technology',securityId:null,identitySource:null,
      amountConvention:'base-decimals',referenceValue:{amount:'999999',currency:'USD',basis:'reference',source},source,
    }];
    expect(summary(portfolio).assetsReference).toBe('19200');
    expect(summary(portfolio).complete).toBe(false);
    expect(portfolioStockReferenceTotal(portfolio)).toBe('17200');
    expect(exposure(portfolio).valuedStockUsd).toBe('17200');
  });

  it('ranks important wallet and posted positions by decimal reference value and caps the list',()=>{
    const rows=importantStockPositions(samplePortfolio(),3);
    expect(rows).toHaveLength(3);
    expect(rows.map(row=>row.referenceValueUsd)).toEqual(['7200','5000','1750']);
    expect(rows.every(row=>row.location!=='earn')).toBe(true);
  });

  it('selects the highest supported loan by liquidation-boundary usage',()=>{
    const portfolio=samplePortfolio();
    const second=structuredClone(portfolio.loans[0]);
    second.id='sample:higher-risk';second.positionId=2;second.positionAddress='sample-position-2';second.positionMint='sample-receipt-2';
    second.debtUnscaled='3500';second.debtAccountingRaw='3500000000000';second.debtValue={...second.debtValue!,amount:'3500'};
    second.ltv='0.7';
    portfolio.loans.push(second);
    const selected=highestRiskLoan(portfolio,{owner:null,cluster:'solana:mainnet',now:Date.parse(portfolio.observedAt)});
    expect(selected?.loan.id).toBe('sample:higher-risk');
    expect(selected?.risk.liquidationBoundaryUsed).toBe('0.933333333333333333333333333333333333333333333333333333333333');
  });
});
