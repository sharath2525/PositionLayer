import { z } from 'zod';

export const MonitoringSeveritySchema = z.enum(['INFO', 'WARN', 'ERROR']);
export const MonitoringProviderSchema = z.enum(['SYSTEM', 'JUPITER', 'XSTOCKS', 'METEORA', 'SOLANA_RPC', 'CACHE']);
export const MonitoringOperationSchema = z.enum([
  'engine_startup', 'asset_registry', 'token_metadata', 'price_fetch', 'lend_vault_list',
  'borrow_positions', 'earn_positions', 'portfolio_positions', 'wallet_token_metadata',
  'wallet_price_fetch', 'quote_only', 'issuer_price', 'multiplier', 'circulating_supply',
  'total_supply', 'proof_of_reserves', 'identity_lookup', 'solana_rpc', 'cache_load',
  'price_worker', 'meteora_pool_index', 'meteora_pool_detail', 'source_comparison',
]);
export const MonitoringStatusSchema = z.enum([
  'STARTED', 'SUCCESS', 'RECOVERED', 'RATE_LIMITED', 'QUEUE_FULL', 'TIMEOUT',
  'NETWORK_ERROR', 'HTTP_4XX', 'HTTP_5XX', 'INVALID_JSON',
  'SCHEMA_VALIDATION_FAILED', 'NORMALIZATION_FAILED', 'CACHE_STALE_FALLBACK',
  'CACHE_LOAD_FAILED', 'RETRY_SCHEDULED', 'BACKOFF_ACTIVE', 'STALE_DATA',
  'SLOW_RESPONSE', 'PRICE_DIVERGENCE',
]);
export const MonitoringErrorCodeSchema = z.enum([
  'RATE_LIMIT', 'QUEUE_FULL', 'TIMEOUT', 'NETWORK', 'HTTP_CLIENT', 'HTTP_SERVER',
  'INVALID_JSON', 'SCHEMA', 'NORMALIZATION', 'CACHE_LOAD', 'STALE', 'UNKNOWN',
  'SLOW_PROVIDER', 'PRICE_DIVERGENCE',
]).nullable();

export const MonitoringEventSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  severity: MonitoringSeveritySchema,
  provider: MonitoringProviderSchema,
  assetOrMint: z.string().min(1).max(64).nullable(),
  operation: MonitoringOperationSchema,
  status: MonitoringStatusSchema,
  latencyMs: z.number().int().min(0).max(3_600_000).nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  errorCode: MonitoringErrorCodeSchema,
  message: z.string().min(1).max(256),
  retryAttempt: z.number().int().min(0).max(20).nullable(),
  fallbackUsed: z.string().min(1).max(64).nullable(),
}).strict();

export type MonitoringSeverity = z.infer<typeof MonitoringSeveritySchema>;
export type MonitoringProvider = z.infer<typeof MonitoringProviderSchema>;
export type MonitoringOperation = z.infer<typeof MonitoringOperationSchema>;
export type MonitoringStatus = z.infer<typeof MonitoringStatusSchema>;
export type MonitoringErrorCode = z.infer<typeof MonitoringErrorCodeSchema>;
export type MonitoringEvent = z.infer<typeof MonitoringEventSchema>;

export const ProviderHealthSchema = z.object({
  provider: MonitoringProviderSchema,
  status: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']),
  lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
  lastFailureAt: z.string().datetime({ offset: true }).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  attemptsLast6h: z.number().int().min(0),
  errorsLast6h: z.number().int().min(0),
  incidentOpen: z.boolean(),
  operations: z.array(z.object({
    operation: MonitoringOperationSchema,
    status: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']),
    lastSuccessAt: z.string().datetime({ offset: true }).nullable(),
    lastFailureAt: z.string().datetime({ offset: true }).nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    attemptsLast6h: z.number().int().min(0),
    errorsLast6h: z.number().int().min(0),
    incidentOpen: z.boolean(),
  }).strict()),
}).strict();

export const MarketEngineHealthSchema = z.object({
  universeLoads: z.number().int().min(0),
  metadataLoads: z.number().int().min(0),
  solanaMintLoads: z.number().int().min(0),
  priceLoads: z.number().int().min(0),
  priceCycles: z.number().int().min(0),
  priceFailures: z.number().int().min(0),
  priceKeys: z.number().int().min(0),
  meteoraIndexLoads: z.number().int().min(0),
  meteoraDetailLoads: z.number().int().min(0),
  worker: z.object({
    status: z.enum(['idle', 'warming', 'refreshing', 'backoff']),
    cached: z.number().int().min(0),
    target: z.number().int().min(0),
    batchSize: z.literal(50),
    cycleSeconds: z.number().int().positive(),
    lastBatchAt: z.string().datetime({ offset: true }).nullable(),
    lastCycleCompletedAt: z.string().datetime({ offset: true }).nullable(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
}).strict();

export const MonitoringSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  retentionHours: z.literal(6),
  store: z.object({ eventCount: z.number().int().min(0), approximateBytes: z.number().int().min(0), maxEvents: z.number().int().positive(), maxBytes: z.number().int().positive() }).strict(),
  providers: z.array(ProviderHealthSchema),
  events: z.array(MonitoringEventSchema).max(100),
  engine: MarketEngineHealthSchema,
}).strict();

export type MonitoringSnapshot = z.infer<typeof MonitoringSnapshotSchema>;
