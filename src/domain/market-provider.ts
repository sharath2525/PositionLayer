import { z } from 'zod';
import { MarketNonnegativeDecimalSchema, MarketTimestampSchema, SolanaStockVariantSchema } from './market-types';

export const ProviderIssueSchema = z.enum([
  'TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'HTTP_SERVER', 'HTTP_CLIENT', 'INVALID_JSON',
  'INVALID_RESPONSE', 'PAGE_MISMATCH', 'PAGE_LIMIT', 'INVALID_RECORD', 'PARTIAL_PAGE',
  'RETAINED_LAST_GOOD', 'COOLDOWN',
]);
export const ProviderCandidateSchema = z.object({
  variant: SolanaStockVariantSchema,
  // The list endpoints do not prove a per-Solana-mint circulating figure.
  supply: z.object({
    scope: z.literal('issuer-all-chain'),
    circulating: MarketNonnegativeDecimalSchema.nullable(),
    total: MarketNonnegativeDecimalSchema.nullable(),
    observedAt: MarketTimestampSchema,
  }).strict().nullable(),
}).strict();
export const ProviderReadResultSchema = z.object({
  provider: z.enum(['xstocks', 'jupiter-stocks-tag']),
  status: z.enum(['ready', 'partial', 'stale', 'unavailable', 'rate-limited']),
  records: z.array(ProviderCandidateSchema).max(5000),
  lastSuccess: MarketTimestampSchema.nullable(),
  lastAttempt: MarketTimestampSchema.nullable(),
  retryAfter: z.number().int().nonnegative().nullable(),
  issues: z.array(ProviderIssueSchema).max(12),
}).strict();

export type ProviderIssue = z.infer<typeof ProviderIssueSchema>;
export type ProviderCandidate = z.infer<typeof ProviderCandidateSchema>;
export type ProviderReadResult = z.infer<typeof ProviderReadResultSchema>;
