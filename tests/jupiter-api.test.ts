import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { byId } from '@/config/instruments';
import { normalizeBorrowPosition, normalizeEarnPosition, normalizeOtherWalletAssets, parseJupiterPriceEntry } from '@/adapters/jupiter-api/read';
import { readXstockIdentities } from '@/adapters/xstocks/assets';
import { sampleSource } from '@/services/sample';

const owner = '7KqWwxfathTjgH3inC4Ztj8xNtgotkWKg3BxBjfYN3LR';
const updatedAt = '2026-09-13T19:41:21.200623245+00:00';

function token(address:string,name:string,symbol:string,decimals:number,price:string){
  return { address,name,symbol,uiSymbol:symbol,decimals,price,updatedAt };
}

describe('Jupiter public API normalization',()=>{
  it('accepts offset/nanosecond timestamps and normalizes the real SOL borrow units',()=>{
    const loan=normalizeBorrowPosition({
      id:9875,vaultId:1,address:'11111111111111111111111111111111',supply:'1000019',borrow:'25100',dustBorrow:'36',isLiquidated:false,ownerAddress:owner,
      vault:{id:1,address:'11111111111111111111111111111111',type:0,
        supplyToken:token(byId.SOL.mint,'Wrapped SOL','SOL',9,'100.8761347901837'),
        borrowToken:token(byId.USDC.mint,'USD Coin','USDC',6,'0.99984'),
        collateralFactor:'800',liquidationThreshold:'850',liquidationPenalty:'100',oraclePriceLiquidate:'100876134790183700',oracleTimestamp:1789328481200},
    },owner,'2026-09-13T19:41:22.000Z');
    expect('protocol' in loan).toBe(true);
    if(!('protocol' in loan)) throw Error('Expected modeled loan');
    expect(loan.collateralUnscaled).toBe('0.001000019');
    expect(loan.debtUnscaled).toBe('0.0251');
    expect(loan.debtAccountingRaw).toBe('25100000');
    expect(loan.liquidationThreshold).toBe('0.85');
    expect(loan.source.observedAt).toMatch(/Z$/);
  });

  it('keeps an unknown vault visible instead of dropping it',()=>{
    const collateralLogoUrl='https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png';
    const debtLogoUrl='https://static.jup.ag/jupUSD/icon.png';
    const loan=normalizeBorrowPosition({
      id:9,vaultId:999,address:'11111111111111111111111111111111',supply:'123',borrow:'456',dustBorrow:'0',isLiquidated:false,ownerAddress:owner,
      vault:{id:999,address:'11111111111111111111111111111111',type:0,
        supplyToken:{...token('VerifiedCollateralMint','NVIDIA xStock','NVDAx',2,'2'),icon:collateralLogoUrl},
        borrowToken:{...token('VerifiedDebtMint','Jupiter USD','JupUSD',6,'1'),icon:debtLogoUrl},
        collateralFactor:'500',liquidationThreshold:'600'},
    },owner);
    expect('protocol' in loan).toBe(false);
    if('protocol' in loan) throw Error('Expected unmodeled loan');
    expect(loan.collateralAmount).toBe('1.23');
    expect(loan.debtAmount).toBe('0.000456');
    expect(loan).toMatchObject({
      collateralMint:'VerifiedCollateralMint', collateralSymbol:'NVDAx', collateralName:'NVIDIA xStock', collateralLogoUrl,
      debtMint:'VerifiedDebtMint', debtSymbol:'JupUSD', debtName:'Jupiter USD', debtLogoUrl,
    });
    expect(loan.reason).toContain('verified local vault/mint mapping');
  });

  it('normalizes nonzero Earn deposits and omits zero receipts',()=>{
    const logoUrl='https://static.jup.ag/usdc/icon.png';
    const base={ownerAddress:owner,shares:'50000',underlyingAssets:'50000',token:{id:2,address:'ReceiptMint',symbol:'jlUSDC',decimals:6,assetAddress:byId.USDC.mint,totalRate:'385',asset:{...token(byId.USDC.mint,'USD Coin','USDC',6,'0.999844'),icon:logoUrl}}};
    const earn=normalizeEarnPosition(base,owner);
    expect(earn?.amount).toBe('0.05');expect(earn?.apy).toBe('0.0385');expect(earn?.referenceValue?.amount).toBe('0.0499922');expect(earn?.logoUrl).toBe(logoUrl);
    expect(normalizeEarnPosition({...base,underlyingAssets:'0'},owner)).toBeNull();
  });

  it('accepts complete Price V3 rows and rejects partial rows without fabricating fields',()=>{
    expect(parseJupiterPriceEntry({usdPrice:100.87,blockId:446784448,decimals:9})?.decimals).toBe(9);
    expect(parseJupiterPriceEntry({createdAt:'2026-09-13T00:00:00Z'})).toBeNull();
  });

  it('rejects owner mismatches',()=>{
    expect(()=>normalizeEarnPosition({ownerAddress:'wrong',shares:'1',underlyingAssets:'1',token:{id:2,address:'receipt',symbol:'jlUSDC',decimals:6,assetAddress:byId.USDC.mint,asset:token(byId.USDC.mint,'USD Coin','USDC',6,'1')}},owner)).toThrow('identity mismatch');
  });

  it('promotes an issuer-verified xStock and values unscaled units once',async()=>{
    const mint='XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN';
    const identities=await readXstockIdentities([{mint,symbol:'GOOGLx',verified:true}]);
    const metadata=new Map([[mint,{id:mint,name:'Alphabet xStock',symbol:'GOOGLx',decimals:8,tokenProgram:byId.NVDAx.tokenProgram,isVerified:true,updatedAt}]]);
    const price={instrumentId:`mint:${mint}`,value:'200',currency:'USD' as const,basis:'reference' as const,per:'unscaled-token' as const,multiplier:null,source:sampleSource};
    const normalized=normalizeOtherWalletAssets([{address:'account',mint,owner,tokenProgram:byId.NVDAx.tokenProgram,raw:'100000000',frozen:false}],owner,metadata,new Map([[mint,price]]),sampleSource,new Set(),
      new Map([[mint,{unscaledAmount:'1',amount:'1.25',spendableAmount:'1.25',convention:'scaled-ui'}]]),identities);
    expect(normalized.assets[0]).toMatchObject({symbol:'GOOGLx',assetClass:'stock',companyId:'ALPHABET',underlyingSymbol:'GOOGL',sector:'Communication Services',amount:'1.25',amountConvention:'scaled-ui',logoUrl:'https://xstocks-metadata.backed.fi/logos/tokens/GOOGLx.png'});
    expect(normalized.assets[0].referenceValue?.amount).toBe('200');
  });

  it('promotes the exact Backpack SPCX mint without trusting its ticker alone',async()=>{
    const mint='SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
    const identities=await readXstockIdentities([{mint,symbol:'SPCX',verified:true}]);
    expect(identities.get(mint)).toMatchObject({
      symbol:'SPCX', assetClass:'stock', companyId:'SPACEX', sector:'Industrials',
      securityId:'BACKPACK:SPCX',
    });
    expect((await readXstockIdentities([{mint:'11111111111111111111111111111111',symbol:'SPCX',verified:true}])).size).toBe(0);
  });
});
