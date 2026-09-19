import { samplePortfolio, sampleSource } from '@/services/sample';
import { referenceValue } from '@/domain/valuation';
import { toBaseUnits } from '@/domain/amounts';
import type { EtfSnapshot, Portfolio } from '@/domain/types';

export const context = { owner:null,cluster:'solana:mainnet',now:Date.parse('2026-09-12T00:00:00Z') };
export function goldenExposurePortfolio(): Portfolio {
  const p=samplePortfolio();p.id='sample-overlap-golden';p.loans=[];
  p.earnPositions=[];
  p.prices.forEach(price=>{price.value=price.instrumentId==='USDC'?'1':'100';});
  const quantities:Record<string,string>={NVDAx:'10',SPYx:'50',QQQx:'30',USDC:'2000'};
  p.holdings=p.holdings.filter(h=>h.scope==='wallet'&&h.instrumentId!=='TSLAx').map(h=>{
    const amount=quantities[h.instrumentId];h.rawAmount=toBaseUnits(amount,h.decimals);h.spendableRawAmount=h.rawAmount;h.unscaledAmount=amount;h.displayAmount=amount;h.spendableAmount=amount;
    h.referenceValue=referenceValue(h,p.prices.find(price=>price.instrumentId===h.instrumentId));return h;
  });
  const fund=(fundId:'SPY'|'QQQ',weight:string):EtfSnapshot=>({id:`sample-${fundId}-weights`,fundId,source:sampleSource,holdingsDate:'2026-09-12',status:'complete',checksum:null,reportedWeight:'1',residualWeight:'0',coverageWeight:'1',note:'Illustrative golden-case weights, not issuer holdings',constituents:[
    {securityId:'fixture-nvidia',ticker:'NVDA',name:'NVIDIA',companyId:'NVIDIA',sector:'Information technology',weight},
    {securityId:`fixture-other-${fundId}`,ticker:'FIXTURE',name:'Other fixture company',companyId:`OTHER_${fundId}`,sector:null,weight:fundId==='SPY'?'0.92':'0.9'},
  ]});p.etfs=[fund('SPY','0.08'),fund('QQQ','0.1')];return p;
}
export function asLive(portfolio: Portfolio): Portfolio {
  const p=structuredClone(portfolio);p.mode='live';p.owner='fixture-public-owner';
  p.holdings.forEach(h=>{h.owner=p.owner!;h.source.kind='live';h.mintState.source.kind='live';if(h.referenceValue)h.referenceValue.source.kind='live';});
  p.loans.forEach(l=>{l.owner=p.owner!;l.source.kind='live';if(l.collateralValue)l.collateralValue.source.kind='live';if(l.debtValue)l.debtValue.source.kind='live';});
  p.walletAssets?.forEach(asset=>{asset.owner=p.owner!;asset.source.kind='live';if(asset.referenceValue)asset.referenceValue.source.kind='live';});
  p.earnPositions?.forEach(position=>{position.owner=p.owner!;position.source.kind='live';if(position.referenceValue)position.referenceValue.source.kind='live';});
  p.unmodeledLoans?.forEach(loan=>{loan.owner=p.owner!;loan.source.kind='live';});
  p.indexedPositions?.forEach(position=>{position.source.kind='live';});
  p.prices.forEach(v=>v.source.kind='live');return p;
}
