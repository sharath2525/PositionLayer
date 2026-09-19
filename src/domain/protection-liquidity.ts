import { z } from 'zod';
import { byId } from '@/config/instruments';
import { decimal, D, scaledDisplay } from './amounts';
import { identityIssues, multiplierEvent, priceMatchesEvent, sourceState, type ReadContext } from './guards';
import { ScenarioSpecSchema, type RepaymentPlan } from './planning-types';
import { decimalString, rawString, unsignedDecimal, type Holding, type Portfolio } from './types';

export const MAX_QUOTE_ATTEMPTS=3;
export const QUOTE_MAX_AGE_MS=30_000;
export const ProtectionLiquidityStateSchema=z.enum(['not-needed','potentially-covered','partially-covered','no-route','expired','unavailable']);
export type ProtectionLiquidityState=z.infer<typeof ProtectionLiquidityStateSchema>;

export const ProtectionLiquidityRequestSchema=z.object({
  mode:z.enum(['sample','live']),owner:z.string().min(32).max(44).nullable(),snapshotId:z.string().min(1).max(180),
  planKey:z.string().min(1).max(2400),loanId:z.string().min(1).max(180),scenario:ScenarioSpecSchema,
  target:unsignedDecimal,targetBasis:z.enum(['current','stressed']),instrumentId:z.string().min(1).max(24),
}).strict().superRefine((value,ctx)=>{
  if(value.mode==='live'&&!value.owner)ctx.addIssue({code:'custom',path:['owner'],message:'Live quote checks require a public wallet address.'});
  if(value.mode==='sample'&&value.owner!==null)ctx.addIssue({code:'custom',path:['owner'],message:'Sample quote checks do not accept a wallet address.'});
});
export type ProtectionLiquidityRequest=z.infer<typeof ProtectionLiquidityRequestSchema>;

export const ProtectionLiquidityEvidenceSchema=z.object({
  schemaVersion:z.literal(1),state:ProtectionLiquidityStateSchema,mode:z.enum(['sample','live']),snapshotId:z.string(),planKey:z.string(),loanId:z.string(),
  inputInstrumentId:z.string().nullable(),inputMint:z.string().nullable(),outputMint:z.string(),tokenProgram:z.string().nullable(),decimals:z.number().int().nullable(),multiplier:unsignedDecimal.nullable(),
  freeInputBaseUnits:rawString.nullable(),freeInputDisplay:unsignedDecimal.nullable(),inputBaseUnits:rawString.nullable(),inputDisplay:unsignedDecimal.nullable(),
  shortfallBaseUnits:rawString,shortfallUsdc:unsignedDecimal,expectedOutputBaseUnits:rawString.nullable(),expectedOutputUsdc:unsignedDecimal.nullable(),
  coverageRatio:unsignedDecimal.nullable(),remainingShortfallUsdc:unsignedDecimal,currentCashUsdc:unsignedDecimal.nullable(),currentCashAfterQuoteUsdc:unsignedDecimal.nullable(),
  router:z.string().nullable(),observedAt:z.string().datetime(),expiresAt:z.string().datetime().nullable(),providerExpiryAt:z.string().datetime().nullable(),
  sourceId:z.string().nullable(),quoteAttemptCount:z.number().int().min(0).max(MAX_QUOTE_ATTEMPTS),transactionCreated:z.literal(false),
  warnings:z.array(z.string()),blockers:z.array(z.string()),disclosure:z.literal('The requested stock-to-USDC pair and exact size are disclosed to Jupiter for this quote check.'),
}).strict();
export type ProtectionLiquidityEvidence=z.infer<typeof ProtectionLiquidityEvidenceSchema>;

export function protectionPlanKey(plan:RepaymentPlan):string{
  return JSON.stringify({mode:plan.mode,owner:plan.owner,cluster:plan.cluster,loanId:plan.positionId,scenario:plan.scenario,target:plan.target,targetBasis:plan.targetBasis,
    repaymentBaseUnits:plan.repaymentBaseUnits,availableUsdc:plan.availableUsdc,shortfallUsdc:plan.shortfallUsdc});
}

export function liquidityContextKey(plan:RepaymentPlan,instrumentId:string):string{
  return JSON.stringify({snapshot:plan.inputKey,plan:protectionPlanKey(plan),instrumentId});
}

export function eligibleProtectionStocks(portfolio:Portfolio,context:ReadContext):Holding[]{
  if(identityIssues(portfolio,context).length)return [];
  return portfolio.holdings.filter(holding=>{
    const instrument=byId[holding.instrumentId];
    if(!instrument||instrument.kind!=='stock'||holding.scope!=='wallet'||holding.rawUnit!=='token-base-unit'||!holding.spendable||BigInt(holding.spendableRawAmount)<=0n)return false;
    if(instrument.mint!==holding.mintState.mint||instrument.tokenProgram!==holding.mintState.tokenProgram||instrument.decimals!==holding.mintState.decimals||holding.decimals!==instrument.decimals)return false;
    if(multiplierEvent(holding.mintState,context.now).stockActionsAffected)return false;
    return [holding.source,holding.mintState.source].every(source=>['fresh','sample'].includes(sourceState(source,portfolio.mode,context.now)));
  });
}

export function initialQuoteInputBaseUnits(portfolio:Portfolio,plan:RepaymentPlan,holding:Holding,context:ReadContext):string{
  const maximum=new D(holding.spendableRawAmount);if(maximum.lte(0))throw Error('No spendable stock base units.');
  if(plan.shortfallUsdc===null||decimal(plan.shortfallUsdc).lte(0))return '0';
  const stockPrice=portfolio.prices.find(price=>price.instrumentId===holding.instrumentId&&price.currency==='USD'&&price.basis==='reference');
  const usdcPrice=portfolio.prices.find(price=>price.instrumentId==='USDC'&&price.currency==='USD'&&price.basis==='reference');
  const usable=(price:typeof stockPrice)=>Boolean(price&&decimal(price.value).gt(0)&&['fresh','sample'].includes(sourceState(price.source,portfolio.mode,context.now)));
  if(!usable(stockPrice)||!usable(usdcPrice)||!stockPrice||!usdcPrice||!priceMatchesEvent(stockPrice,holding.mintState))return maximum.toFixed(0);
  const stockUnitsPerRaw=new D(10).pow(holding.decimals).pow(-1).mul(stockPrice.per==='display-token'?holding.mintState.multiplier:'1');
  const valuePerRaw=stockUnitsPerRaw.mul(stockPrice.value);if(valuePerRaw.lte(0))return maximum.toFixed(0);
  const estimate=decimal(plan.shortfallUsdc).mul(usdcPrice.value).div(valuePerRaw).ceil();
  return D.max(1,D.min(maximum,estimate)).toFixed(0);
}

export function nextQuoteInputBaseUnits(current:string,output:string,requiredOutput:string,maximum:string):string|null{
  const input=new D(current),out=new D(output),need=new D(requiredOutput),max=new D(maximum);
  if(input.lte(0)||out.lte(0)||need.lte(0)||max.lte(0))return null;
  let next=input.mul(need).div(out).ceil();
  if(out.lt(need))next=D.max(input.add(1),next);
  if(out.gte(need))next=D.min(input.sub(1),next);
  next=D.max(1,D.min(max,next));
  return next.eq(input)?null:next.toFixed(0);
}

export function parseQuoteExpiry(value:string|null,observedAt:number,eventAt:number|null):{expiresAt:string;providerExpiryAt:string|null}{
  let provider:number|null=null;
  if(value){const numeric=/^\d+$/.test(value)?Number(value):NaN;provider=Number.isFinite(numeric)?numeric*(numeric<10_000_000_000?1000:1):Date.parse(value);if(!Number.isFinite(provider))provider=null;}
  const event=eventAt===null?null:eventAt*1000;
  const expires=Math.min(observedAt+QUOTE_MAX_AGE_MS,...[provider,event].filter((item):item is number=>item!==null));
  return {expiresAt:new Date(expires).toISOString(),providerExpiryAt:provider===null?null:new Date(provider).toISOString()};
}

export function currentLiquidityEvidence(evidence:ProtectionLiquidityEvidence,currentKey:string,now:number):ProtectionLiquidityEvidence|null{
  if(evidence.planKey!==currentKey)return null;
  if(evidence.expiresAt&&now>=Date.parse(evidence.expiresAt)&&['potentially-covered','partially-covered','no-route'].includes(evidence.state)){
    return ProtectionLiquidityEvidenceSchema.parse({...evidence,state:'expired',warnings:[...evidence.warnings,'This quote observation expired. Request a new check if the plan inputs are still current.']});
  }
  return evidence;
}

export function displayInputAmount(raw:string,holding:Holding):string{return scaledDisplay(raw,holding.decimals,holding.mintState.multiplier);}
export function quoteCoverage(outputBaseUnits:string,shortfallBaseUnits:string):{coverage:string;remaining:string}{
  const output=new D(outputBaseUnits),shortfall=new D(shortfallBaseUnits);
  return {coverage:shortfall.isZero()?'1':output.div(shortfall).toFixed(),remaining:D.max(0,shortfall.sub(output)).div('1000000').toFixed()};
}
export const quoteDecimalString=decimalString;
