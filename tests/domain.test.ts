import { describe, expect, it } from 'vitest';
import { decimal, effectiveMultiplier, fromBaseUnits, scaledDisplay, sum, toBaseUnits, ratio } from '@/domain/amounts';
import { identify, byId } from '@/config/instruments';
import { normalizeAccounts, type TokenAccount } from '@/adapters/solana/accounts';
import { normalizePosition, type PositionInput } from '@/adapters/jupiter-lend/normalize';
import { exposure } from '@/domain/exposure';
import { referenceValue, summary } from '@/domain/valuation';
import { samplePortfolio, sampleSource, sampleProvider } from '@/services/sample';
import { holdingsSnapshots } from '@/adapters/holdings/snapshots';
import { PortfolioResultSchema } from '@/domain/types';
import { parseSpyRows } from '@/adapters/holdings/parse-spy';
import { browserLiveProvider } from '@/services/browser-live';
import { vi } from 'vitest';
import { amount, number, usdAmount } from '@/components/format';

describe('precise amounts and units', () => {
  it('formats display fractions without thousands separators inside decimals',()=>{expect(number('123456.123456',6)).toBe('123,456.123456');expect(number('14',4)).toBe('14.0000');});
  it('keeps small nonzero financial amounts visible',()=>{expect(amount('0.0251')).toBe('0.03');expect(amount('0.000077344')).toBe('0.0001');expect(amount('0.0000000001')).toBe('< 0.000000001');expect(usdAmount('0.0001')).toBe('$0.0001');});
  it('preserves balances beyond JS safe integer range', () => {
    expect(fromBaseUnits('900719925474099312345678',8)).toBe('9007199254740993.12345678');
    expect(toBaseUnits('9007199254740993.12345678',8)).toBe('900719925474099312345678');
  });
  it('distinguishes protocol 1e9 from USDC base units', () => {
    expect(fromBaseUnits('100000000',9)).toBe('0.1');
    expect(toBaseUnits('0.1',6)).toBe('100000');
    expect(fromBaseUnits('100000000',6)).toBe('100');
  });
  it.each(['NaN','Infinity','1e9','-1','1.0000001'])('rejects invalid/excess precision base input %s', v => expect(()=>toBaseUnits(v,6)).toThrow());
  it('never double-applies the Token-2022 multiplier', () => expect(scaledDisplay('10000000000',8,'2')).toBe('200'));
  it('uses chain time at the scheduled multiplier boundary', () => {
    expect(effectiveMultiplier('1','2',100,99)).toBe('1'); expect(effectiveMultiplier('1','2',100,100)).toBe('2');
    expect(()=>effectiveMultiplier('0',null,null,100)).toThrow();
  });
  it('keeps missing/zero-denominator ratios unavailable', () => { expect(ratio('10','0')).toBeNull(); expect(ratio('0','10')).toBe('0'); });
});

describe('verified identity and wallet normalization', () => {
  const instrument = byId.NVDAx;
  it('recognizes a direct stock and ETF only with complete mint identity', () => {
    expect(identify(instrument.chain,instrument.mint,instrument.tokenProgram,8)?.id).toBe('NVDAx');
    expect(identify(byId.SPYx.chain,byId.SPYx.mint,byId.SPYx.tokenProgram,8)?.kind).toBe('etf');
  });
  it('rejects spoofed symbols, wrong chain, program and decimals', () => {
    expect(identify(instrument.chain,'NVDAx',instrument.tokenProgram,8)).toBeUndefined();
    expect(identify('solana:devnet',instrument.mint,instrument.tokenProgram,8)).toBeUndefined();
    expect(identify(instrument.chain,instrument.mint,byId.USDC.tokenProgram,8)).toBeUndefined();
    expect(identify(instrument.chain,instrument.mint,instrument.tokenProgram,6)).toBeUndefined();
  });
  const state = samplePortfolio().holdings.find(h=>h.instrumentId==='USDC')!.mintState;
  const account = (address: string, raw: string, frozen = false): TokenAccount => ({ address, raw, frozen, mint: byId.USDC.mint, owner: 'owner', tokenProgram: byId.USDC.tokenProgram });
  it('aggregates multiple accounts and separates frozen cash', () => {
    const result = normalizeAccounts([account('a','1234567'),account('b','2000000',true)],'owner',[state],sampleSource);
    expect(result.holdings[0].rawAmount).toBe('3234567');
    expect(result.holdings[0].displayAmount).toBe('3.234567');
    expect(result.holdings[0].spendableAmount).toBe('1.234567');
  });
  it('rejects duplicate accounts and wrong ownership', () => {
    expect(()=>normalizeAccounts([account('a','1'),account('a','1')],'owner',[state],sampleSource)).toThrow('Duplicate');
    expect(()=>normalizeAccounts([account('a','1')],'different-owner',[state],sampleSource)).toThrow('owner mismatch');
  });
  it('excludes receipt tokens even if metadata is spoofed', () => {
    const result = normalizeAccounts([{...account('receipt','1'),mint:'position-receipt'}],'owner',[state],sampleSource,new Set(['position-receipt']));
    expect(result.holdings).toHaveLength(0); expect(result.unsupported[0].reason).toContain('Position receipt excluded');
  });
  it('does not normalize unverified mints', () => {
    expect(normalizeAccounts([account('a','100')],'owner',[],sampleSource).unsupported).toHaveLength(1);
  });
});

describe('protocol-account boundary: labeled synthetic inputs', () => {
  const input: PositionInput = { vaultId:80,positionId:99,owner:'owner',requestedOwner:'owner',positionAddress:'fixture',positionMint:'receipt',
    supplyMint:byId.NVDAx.mint,borrowMint:byId.USDC.mint,supply1e9:'10000000000',borrow1e9:'750000000000',vaultType:0,
    collateralFactorPermille:'650',liquidationThresholdPermille:'750',liquidationPenaltyBps:'300',liquidatePrice1e15:'125000000000000000',isLiquidated:false,source:sampleSource };
  it('converts balances and distinct risk parameters with protocol price units', () => {
    const loan = normalizePosition(input);
    expect(loan.collateralUnscaled).toBe('10'); expect(loan.debtUnscaled).toBe('750');
    expect(loan.collateralValue?.amount).toBe('1250'); expect(loan.collateralValue?.currency).toBe('USDC');
    expect(loan.ltv).toBe('0.6'); expect(loan.maxBorrowLtv).toBe('0.65'); expect(loan.liquidationThreshold).toBe('0.75'); expect(loan.liquidationPenalty).toBe('0.03');
    expect(loan.capabilities.positionReadable).toBe(true);
  });
  it('preserves debt when liquidation price is unavailable', () => { const loan=normalizePosition({...input,liquidatePrice1e15:null}); expect(loan.ltv).toBeNull(); expect(loan.collateralValue).toBeNull(); expect(loan.debtUnscaled).toBe('750'); });
  it('handles zero collateral without a finite LTV',()=>expect(normalizePosition({...input,supply1e9:'0'}).ltv).toBeNull());
  it('refuses wrong vault mints, owner, and smart shares', () => {
    expect(()=>normalizePosition({...input,requestedOwner:'other'})).toThrow('owner');
    expect(()=>normalizePosition({...input,supplyMint:byId.SPYx.mint})).toThrow('identity');
    expect(()=>normalizePosition({...input,vaultType:2})).toThrow('Unsupported');
  });
});

describe('reference valuation and exposure', () => {
  it('sample values are labeled and validate at the service boundary', async () => {
    const result = await sampleProvider.read(null); expect(PortfolioResultSchema.safeParse(result).success).toBe(true);
    if(result.status==='error')throw Error('Unexpected error');
    expect(result.data.mode).toBe('sample'); expect(result.data.holdings.every(h=>h.source.kind==='sample')).toBe(true);
  });
  it('rejects incompatible/unverified prices while retaining explicitly dated stale reference values', () => {
    const p=samplePortfolio(); const h=p.holdings[0]; const price=p.prices[0];
    expect(referenceValue(h,{...price,basis:'protocol'})).toBeNull(); expect(referenceValue(h,{...price,basis:'quote'})).toBeNull();
    expect(referenceValue(h,{...price,multiplier:'2'})).toBeNull(); expect(referenceValue(h,{...price,source:{...price.source,validity:'unverified'}})).toBeNull();
    expect(referenceValue(h,{...price,source:{...price.source,validity:'stale'}})?.source.validity).toBe('stale');
  });
  it('sums direct + posted + ETF contributions without counting cash or receipts', () => {
    const p=samplePortfolio(); const result=exposure(p); const nvda=result.companies.find(c=>c.id==='NVIDIA')!;
    expect(nvda.directUsd).toBe('7000');
    expect(nvda.etfUsd).toBe('581.826312'); // $7,200 SPY * issuer 8.080921%.
    expect(nvda.amountUsd).toBe('7581.826312'); expect(nvda.contributions).toHaveLength(4);
    expect(nvda.contributions.some(contribution=>contribution.scope==='earn')).toBe(true);
    expect(result.valuedStockUsd).toBe('17200');
    expect(sum([result.knownCompanyUsd,result.unknownCompanyUsd])).toBe('17200');
    expect(sum(result.sectors.map(s=>s.amountUsd))).toBe('17200');
    expect(result.sectors.map(s=>s.name)).toEqual(expect.arrayContaining(['Information Technology','Financials','Health Care','Unknown / unclassified']));
    expect(result.sectors.find(s=>s.name==='Information Technology')?.etfUsd).toBe('2746.8');
    expect(decimal(result.unknownCompanyUsd).gte('1500')).toBe(true); // QQQ alone.
  });
  it('separates unpriced holdings from unknown constituents', () => {
    const p=samplePortfolio(); p.holdings[0].referenceValue=null;
    const result=exposure(p); expect(result.unvaluedStockHoldings).toBe(1); expect(result.valuedStockUsd).toBe('15450');
  });
  it('never calls unread debt zero or assumes USDC USD parity', () => {
    const p=samplePortfolio(); p.loans=[]; p.loanRead='blocked'; p.prices=[];
    expect(summary(p).debtUsdc).toBeNull(); expect(summary(p).equityReference).toBeNull(); expect(summary(p).complete).toBe(false);
  });
  it('has a reconciled net equity only within declared reference coverage',()=>expect(summary(samplePortfolio()).equityReference).toBe('16200'));
});

describe('dated issuer holdings', () => {
  it('retains all imported weights plus residual without renormalizing', () => {
    const [spy,qqq]=holdingsSnapshots();
    expect(spy.holdingsDate).toBe('2026-09-10'); expect(spy.constituents).toHaveLength(505);
    expect(sum(spy.constituents.map(c=>c.weight))).toBe('0.99960481'); expect(sum([spy.reportedWeight,spy.residualWeight])).toBe('1');
    expect(spy.coverageWeight).toBe('0.99775977'); expect(qqq.status).toBe('unavailable'); expect(qqq.constituents).toHaveLength(0);
  });
  it('merges known multiple share classes into company identity',()=>{const spy=holdingsSnapshots()[0];const alphabet=spy.constituents.filter(c=>c.companyId==='ALPHABET'); expect(alphabet).toHaveLength(2); expect(alphabet.map(c=>c.ticker).sort()).toEqual(['GOOG','GOOGL']);});
  it('rejects a top-ten table masquerading as full holdings',()=>expect(()=>parseSpyRows([], '2026-09-10',sampleSource.observedAt,'hash')).toThrow('full SPY'));
});

describe('live service transport',()=>{
  it('returns live errors without calling sample provider',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'error',code:'RPC_BLOCKED',message:'RPC unavailable'}),{status:502}));
    try{expect(await browserLiveProvider.read(byId.USDC.mint)).toEqual({status:'error',code:'RPC_BLOCKED',message:'RPC unavailable'});}finally{mock.mockRestore();}
  });
  it('rejects a sample response or old wallet response on the live channel',async()=>{
    const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'partial',data:samplePortfolio()})));
    try{await expect(browserLiveProvider.read(byId.USDC.mint)).rejects.toThrow('identity mismatch');}finally{mock.mockRestore();}
  });
});
