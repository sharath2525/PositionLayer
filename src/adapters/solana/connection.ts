import { Connection } from "@solana/web3.js";
import { MAINNET_GENESIS } from "@/config/instruments";
import { classifyProviderError } from '@/services/monitoring/instrument-provider';
import { noteProviderAttempt, noteProviderFailure, noteProviderSuccess } from '@/services/monitoring/provider-health';

// Called only from server services and CLI probes. Never serialized to clients.
export function createConnection(signal?: AbortSignal): Connection {
  if (process.env.APP_CLUSTER && process.env.APP_CLUSTER !== "solana:mainnet") throw new Error("Only solana:mainnet is supported");
  const endpoint = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  let queue = Promise.resolve();
  const interval = endpoint === "https://api.mainnet-beta.solana.com" ? 1100 : 0;
  return new Connection(endpoint, { commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: async (url, options) => {
      // The official SDK fans out account reads. Pace the public endpoint to its
      // per-method rate limit; no hidden retries or replacement data.
      const turn = queue;
      queue = turn.then(() => new Promise<void>(resolve => setTimeout(resolve, interval)));
      await turn;
      const timeout = AbortSignal.timeout(20000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const started = performance.now();
      noteProviderAttempt('SOLANA_RPC', 'solana_rpc');
      try {
        const response = await fetch(url, { ...options, signal: combined, cache: 'no-store' });
        if (process.env.PROBE_TRACE === '1') console.log(JSON.parse(String(options?.body)).method, response.status);
        if (response.ok) noteProviderSuccess('SOLANA_RPC', 'solana_rpc', performance.now() - started);
        else noteProviderFailure({ provider: 'SOLANA_RPC', operation: 'solana_rpc', status: response.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX', errorCode: response.status >= 500 ? 'HTTP_SERVER' : 'HTTP_CLIENT', httpStatus: response.status, latencyMs: performance.now() - started, message: `Solana RPC HTTP ${response.status}.` });
        return response;
      }
      catch (error) {
        const normalized = timeout.aborted && !signal?.aborted ? Error('Solana RPC timed out.') : error;
        const classified = classifyProviderError(normalized);
        if (!classified.ignored) noteProviderFailure({ provider: 'SOLANA_RPC', operation: 'solana_rpc', ...classified, latencyMs: performance.now() - started });
        throw new Error("RPC request failed or timed out. Check the server RPC configuration.");
      }
    },
  });
}
export async function verifyCluster(connection: Connection) {
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("RPC cluster does not match Solana mainnet");
}
export function safeError(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let i = 0; i < 5 && current instanceof Error; i++) {
    messages.push(current.message);
    current = current.cause;
  }
  const message = messages.join(' → ') || (typeof error === 'string' ? error : error && typeof error === 'object' ? JSON.stringify(error) : "Unknown provider error");
  return message.replace(/https?:\/\/[^\s\"']+/g, "[provider URL]").replace(/(?:api[-_]?key|token|authorization)[=:]\s*[^\s,;]+/gi, "[credential redacted]").slice(0, 700);
}
