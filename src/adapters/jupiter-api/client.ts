import 'server-only';
import { z } from 'zod';
import type { MonitoringOperation } from '@/domain/monitoring';
import { observeProviderCall } from '@/services/monitoring/instrument-provider';
import { noteRetry } from '@/services/monitoring/provider-health';

export class JupiterApiError extends Error {
  constructor(public readonly kind:'aborted'|'timeout'|'rate-limited'|'http'|'malformed',public readonly status:number|null,message:string,public readonly retryAfterSeconds:number|null=null){super(message);this.name='JupiterApiError';}
}

const MAX_WAITING_REQUESTS=24;
const state = globalThis as typeof globalThis & { positionLayerJupiterQueue?: Promise<void>; positionLayerJupiterLast?: number; positionLayerJupiterWaiting?:number };
state.positionLayerJupiterQueue ??= Promise.resolve();
state.positionLayerJupiterLast ??= 0;
state.positionLayerJupiterWaiting ??= 0;

async function takeTurn(signal?:AbortSignal, forceKeyless = false) {
  if(state.positionLayerJupiterWaiting!>=MAX_WAITING_REQUESTS)throw new JupiterApiError('rate-limited',429,'Jupiter request queue is full.');
  state.positionLayerJupiterWaiting!++;
  const interval = !forceKeyless && process.env.JUPITER_API_KEY ? 1100 : 2100;
  const previous = state.positionLayerJupiterQueue!;
  let release!: () => void;
  state.positionLayerJupiterQueue = new Promise<void>(resolve => { release = resolve; });
  try{
    await previous;
    if(signal?.aborted)throw new JupiterApiError('aborted',null,'Jupiter request was cancelled.');
    const wait = Math.max(0, state.positionLayerJupiterLast! + interval - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if(signal?.aborted)throw new JupiterApiError('aborted',null,'Jupiter request was cancelled.');
    state.positionLayerJupiterLast = Date.now();
  }finally{
    state.positionLayerJupiterWaiting=Math.max(0,state.positionLayerJupiterWaiting!-1);
    release();
  }
}

export function retryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

export function jupiterRequestHeaders(forceKeyless: boolean, apiKey = process.env.JUPITER_API_KEY) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (!forceKeyless && apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

async function waitFor(milliseconds:number,signal?:AbortSignal) {
  if (signal?.aborted) throw new JupiterApiError('aborted',null,'Jupiter request was cancelled.');
  await new Promise<void>((resolve,reject) => {
    const timer=setTimeout(resolve,milliseconds);
    signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new JupiterApiError('aborted',null,'Jupiter request was cancelled.'));},{once:true});
  });
}

export async function jupiterJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, policy: 'generic'|'wallet-specific'|'global-market'|'keyless-global-market' = 'generic', operation: MonitoringOperation = 'token_metadata'): Promise<T> {
  const forceKeyless = policy === 'keyless-global-market';
  const headers: HeadersInit = jupiterRequestHeaders(forceKeyless);
  for(let attempt=0;attempt<2;attempt++){
    try {
      return await observeProviderCall({ provider: 'JUPITER', operation }, async () => {
        await takeTurn(signal, forceKeyless);
        const timeout = AbortSignal.timeout(15000);
        let response:Response;
        try {
          response = await fetch(`https://api.jup.ag${path}`, {
            headers,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            ...((policy === 'wallet-specific' || policy === 'global-market' || policy === 'keyless-global-market') ? { cache: 'no-store' as const } : { next: { revalidate: 20 } }),
          });
        } catch (error) {
          if (signal?.aborted) throw new JupiterApiError('aborted',null,'Jupiter request was cancelled.');
          if (timeout.aborted) throw new JupiterApiError('timeout',null,'Jupiter request timed out.');
          throw error;
        }
        if(response.status===429){
          const retryAfter=retryAfterSeconds(response.headers.get('retry-after'));
          throw new JupiterApiError('rate-limited',429,'Jupiter API rate limit reached.',retryAfter);
        }
        if (!response.ok) throw new JupiterApiError('http',response.status,`Jupiter API HTTP ${response.status}`);
        let body:unknown;
        try { body=await response.json(); }
        catch { throw new JupiterApiError('malformed',response.status,'Jupiter returned malformed JSON.'); }
        const parsed=schema.safeParse(body);
        if(!parsed.success)throw new JupiterApiError('malformed',response.status,'Jupiter response failed schema validation.');
        return parsed.data;
      });
    } catch (error) {
      if (error instanceof JupiterApiError && error.kind === 'rate-limited' && attempt === 0 && error.retryAfterSeconds !== null && error.retryAfterSeconds <= 5) {
        noteRetry({ provider: 'JUPITER', operation, retryAttempt: attempt + 1, delayMs: error.retryAfterSeconds * 1_000 });
        await waitFor(error.retryAfterSeconds * 1_000, signal);
        continue;
      }
      throw error;
    }
  }
  throw new JupiterApiError('rate-limited',429,'Jupiter API rate limit reached.');
}
