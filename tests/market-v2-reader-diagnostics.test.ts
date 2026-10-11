import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  remote: vi.fn(), snapshot: vi.fn(), project: vi.fn(), progress: vi.fn(), event: vi.fn(),
}));
vi.mock('@/services/market-v2-remote', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/market-v2-remote')>(),
  readRemoteCanonicalPage: mocks.remote,
}));
vi.mock('@/services/market-durable-store', () => ({
  getRuntimeMarketSnapshotStore: () => ({ readProgress: mocks.progress }),
}));
vi.mock('@/services/market-v2-engine', () => ({ bundledMarketV2Catalog: () => null }));
vi.mock('@/services/market-snapshot-reader', () => ({ readMarketSnapshot: mocks.snapshot }));
vi.mock('@/services/stock-rich-store', () => ({ currentRichStore: () => undefined }));
vi.mock('@/services/stocks-market', () => ({ getCachedStockContext: () => undefined }));
vi.mock('@/services/monitoring/log-manager', () => ({ recordMarketEvent: mocks.event }));
vi.mock('@/domain/market-api-v2', async importOriginal => ({
  ...await importOriginal<typeof import('@/domain/market-api-v2')>(),
  projectCanonicalMarket: mocks.project,
}));
import { CanonicalMarketQuerySchema } from '@/domain/market-api-v2';
import { readCanonicalMarketPage } from '@/services/market-v2-reader';
import { GET } from '@/app/api/markets/v2/stocks/route';

const secret = 'PRIVATE_SENTINEL_https://user:password@private.example/?key=secret';
const page = { status: 'degraded', source: 'current', records: [], marker: 'unchanged-payload' };
const request = (query = '') => new Request(`https://frontend.example/api/markets/v2/stocks${query}`);

beforeEach(() => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('MARKET_V2_WRITER_ORIGIN', 'https://writer.example.org');
  vi.stubEnv('APP_ORIGIN', 'https://frontend.example');
  mocks.remote.mockReset().mockResolvedValue(page);
  mocks.snapshot.mockReset().mockResolvedValue({ snapshot: null });
  mocks.project.mockReset().mockReturnValue({ ...page, source: 'bundled' });
  mocks.progress.mockReset().mockResolvedValue(null);
  mocks.event.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('canonical reader stages and unchanged route responses', () => {
  it('returns successful remote data unchanged without reading local fallback or logging', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=15, stale-while-revalidate=30');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.remote).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ['MARKET_V2_WRITER_ORIGIN', secret, 'TypeError', 'invalid_origin_url'],
    ['APP_ORIGIN', secret, 'TypeError', 'invalid_origin_url'],
    ['MARKET_V2_WRITER_ORIGIN', 'http://writer.example.org', 'Error', 'origin_requires_https'],
    ['MARKET_V2_WRITER_ORIGIN', `https://writer.example.org/${secret}`, 'Error', 'origin_not_bare'],
    ['MARKET_V2_WRITER_ORIGIN', 'https://frontend.example', 'Error', 'origin_self_reference'],
  ])('logs rejected origins safely and preserves the generic 503 (%#)', async (variable, value, errorType, reason) => {
    vi.stubEnv(variable, value);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'error', message: 'Canonical market data is temporarily unavailable.' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith({
      event: 'canonical_reader_failure', stage: 'origin_validation', errorType, reason,
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });

  it('preserves local catalog fallback after a remote failure', async () => {
    mocks.remote.mockRejectedValueOnce(new Error(secret));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...page, source: 'bundled' });
    expect(mocks.remote).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.event).toHaveBeenCalledTimes(1);
    // Transport diagnostics are tested with the real remote implementation separately.
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'project'] as const)('logs a failed local %s fallback and rethrows the same exception', async stage => {
    const error = new Error(secret);
    mocks.remote.mockRejectedValue(new Error('upstream failure'));
    if (stage === 'snapshot') mocks.snapshot.mockRejectedValue(error);
    else mocks.project.mockImplementation(() => { throw error; });
    await expect(readCanonicalMarketPage(CanonicalMarketQuerySchema.parse({}))).rejects.toBe(error);
    expect(mocks.remote).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledExactlyOnceWith({ event: 'canonical_reader_failure',
      stage: 'fallback', errorType: 'Error', reason: 'unclassified_failure' });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'error', message: 'Canonical market data is temporarily unavailable.' });
  });

  it('preserves the existing swallowed progress failure', async () => {
    mocks.remote.mockRejectedValueOnce(new Error('upstream failure'));
    mocks.progress.mockRejectedValueOnce(new Error(secret));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...page, source: 'bundled' });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(['?invalid=1', '?pageSize=0', '?page=1&page=2'])('preserves query rejection for %s', async query => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: 'error', message: 'Invalid canonical market query.' });
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('preserves the reader loop guard and its 508 response', async () => {
    const response = await GET(new Request(request(), { headers: { 'X-PositionLayer-Market-Hop': '1' } }));
    expect(response.status).toBe(508);
    expect(await response.json()).toEqual({ status: 'error', message: 'Canonical market reader cannot proxy another reader.' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps origin diagnostics disabled outside Vercel', async () => {
    vi.stubEnv('VERCEL', '0');
    vi.stubEnv('MARKET_V2_WRITER_ORIGIN', secret);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(console.error).not.toHaveBeenCalled();
  });
});
