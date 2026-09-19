import { PublicKey } from '@solana/web3.js';
import { ProtectionLiquidityEvidenceSchema,ProtectionLiquidityRequestSchema } from '@/domain/protection-liquidity';
import type { Portfolio } from '@/domain/types';
import { liveProvider } from '@/services/live';
import { samplePortfolio } from '@/services/sample';
import { liquidityExamplePortfolio } from '@/services/worked-example';
import { checkProtectionLiquidity } from '@/services/protection-liquidity';
import { actionError,actionResponse,readActionBody } from '@/services/route-input';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=180;

const globalRate=globalThis as typeof globalThis&{positionLayerLiquidityRate?:Map<string,number>};
globalRate.positionLayerLiquidityRate??=new Map();
export function allowLiquidityRequest(key:string,now=Date.now()):boolean{
  const table=globalRate.positionLayerLiquidityRate!;const last=table.get(key)??0;
  if(now-last<4_000)return false;
  table.set(key,now);
  if(table.size>200)for(const [candidate,at] of table)if(now-at>300_000)table.delete(candidate);
  return true;
}

export async function POST(request:Request){
  try{
    const parsed=ProtectionLiquidityRequestSchema.safeParse(await readActionBody(request,12_000));
    if(!parsed.success)return actionResponse({error:'Provide a valid protection-plan quote request.',code:'INVALID_INPUT'},400);
    const input=parsed.data;
    if(input.owner)try{new PublicKey(input.owner);}catch{return actionResponse({error:'Invalid Solana wallet address.',code:'INVALID_WALLET'},400);}
    const rateKey=input.owner??`sample:${input.snapshotId}`;
    if(!allowLiquidityRequest(rateKey))return actionResponse({error:'Quote checks are rate-limited. Wait a few seconds and try again.',code:'RATE_LIMITED'},429);
    let portfolio:Portfolio;
    if(input.mode==='sample'){
      portfolio=input.snapshotId==='sample-liquidity-example-v1'?liquidityExamplePortfolio():samplePortfolio();
      if(portfolio.id!==input.snapshotId)return actionResponse({error:'Unknown sample snapshot.',code:'INVALID_SNAPSHOT'},400);
    }else{
      const result=await liveProvider.read(input.owner,request.signal);
      if(result.status==='error')return actionResponse({error:'Live portfolio validation failed before the quote check.',code:'LIVE_VALIDATION_FAILED'},502);
      portfolio=result.data;
    }
    const result=ProtectionLiquidityEvidenceSchema.parse(await checkProtectionLiquidity(portfolio,input,request.signal));
    return actionResponse(result);
  }catch(error){return actionError(error);}
}
