'use client';
import { ProtectionLiquidityEvidenceSchema,type ProtectionLiquidityEvidence,type ProtectionLiquidityRequest } from '@/domain/protection-liquidity';

export async function readProtectionLiquidity(input:ProtectionLiquidityRequest,signal?:AbortSignal):Promise<ProtectionLiquidityEvidence>{
  const response=await fetch('/api/protection-liquidity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal,cache:'no-store'});
  const body:unknown=await response.json();
  const parsed=ProtectionLiquidityEvidenceSchema.safeParse(body);
  if(!parsed.success){
    const error=body&&typeof body==='object'&&'error' in body&&typeof body.error==='string'?body.error:`Liquidity check failed with HTTP ${response.status}.`;
    throw Error(error);
  }
  return parsed.data;
}
