import 'server-only';
import { safeError } from '@/adapters/solana/connection';

export async function readActionBody(request:Request,maxBytes=650000):Promise<unknown> {
  const origin=request.headers.get('origin');
  // Next may use an internal hostname in Request.url. Match the browser-facing
  // Host instead; HTTPS reverse proxies must set a fixed server-only APP_ORIGIN.
  // Never infer trust from arbitrary forwarded-host/proto headers.
  const url=new URL(request.url);
  const configured=process.env.APP_ORIGIN;
  const expected=new URL(configured||`${url.protocol}//${request.headers.get('host')||url.host}`);
  if(expected.username||expected.password||expected.pathname!=='/'||expected.search||expected.hash||!['http:','https:'].includes(expected.protocol))throw Error('APP_ORIGIN must be an HTTP(S) origin without credentials or a path.');
  if(origin!==expected.origin)throw Error('A same-origin user request is required.');
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('JSON content type is required.');
  const reader=request.body?.getReader();if(!reader)throw Error('Request body missing.');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes)throw Error('Request body exceeds the allowed size.');chunks.push(value);}}
  finally{await reader.cancel();}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export const actionResponse=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export const actionError=(error:unknown)=>actionResponse({error:safeError(error)},400);
