import 'server-only';
import { z } from 'zod';
import { byId } from '@/config/instruments';
import { rawString } from '@/domain/types';
import { jupiterJson } from './client';

const QuoteOnlyOrderSchema=z.object({
  mode:z.string().min(1),inputMint:z.string().min(32),outputMint:z.string().min(32),
  inAmount:rawString,outAmount:rawString,router:z.string().min(1).max(32),
  transaction:z.null(),requestId:z.string().min(1),expireAt:z.string().min(1).nullish(),
}).passthrough();

export type QuoteOnlyOrder={
  inputMint:string;outputMint:string;inAmount:string;outAmount:string;router:string;
  expireAt:string|null;requestId:string;
};

export function quoteOnlyOrderPath(instrumentId:string,inputBaseUnits:string):string {
  if(!/^\d+$/.test(inputBaseUnits)||BigInt(inputBaseUnits)<=0n)throw Error('Quote input must be positive token base units.');
  const input=byId[instrumentId];const output=byId.USDC;
  if(!input||input.kind!=='stock'||input.chain!=='solana:mainnet')throw Error('Only a verified stock input is supported.');
  const query=new URLSearchParams({inputMint:input.mint,outputMint:output.mint,amount:inputBaseUnits});
  return `/swap/v2/order?${query.toString()}`;
}

export function parseQuoteOnlyOrderResponse(body:unknown,instrumentId:string,inputBaseUnits:string):QuoteOnlyOrder{
  const expectedInput=byId[instrumentId];const expectedOutput=byId.USDC;
  if(!expectedInput)throw Error('Unknown quote input instrument.');
  const row=QuoteOnlyOrderSchema.parse(body);
  if(row.inputMint!==expectedInput.mint||row.outputMint!==expectedOutput.mint||row.inAmount!==inputBaseUnits)throw Error('Jupiter quote identity or input amount mismatch.');
  if(BigInt(row.outAmount)<=0n)throw Error('Jupiter quote output is unusable.');
  return {inputMint:row.inputMint,outputMint:row.outputMint,inAmount:row.inAmount,outAmount:row.outAmount,router:row.router,expireAt:row.expireAt??null,requestId:row.requestId};
}

export async function readQuoteOnlyOrder(instrumentId:string,inputBaseUnits:string,signal?:AbortSignal):Promise<QuoteOnlyOrder>{
  const row=await jupiterJson(quoteOnlyOrderPath(instrumentId,inputBaseUnits),QuoteOnlyOrderSchema,signal,'wallet-specific','quote_only');
  return parseQuoteOnlyOrderResponse(row,instrumentId,inputBaseUnits);
}
