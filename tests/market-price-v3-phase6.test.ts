import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/adapters/jupiter-api/client', () => ({
  jupiterJson: vi.fn(),
  JupiterApiError: class JupiterApiError extends Error {
    constructor(public readonly kind: string, public readonly status: number | null,
      message: string, public readonly retryAfterSeconds: number | null = null) { super(message); }
  },
}));
import { jupiterJson, JupiterApiError } from '@/adapters/jupiter-api/client';
import { readJupiterPriceV3Batch } from '@/adapters/market/jupiter-price-v3-batch';
import { normalizeStockUniverse } from '@/adapters/market/stocks';
import { adaptLegacyXstockRecord } from '@/domain/market-identity-adapter';

const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const variant = adaptLegacyXstockRecord(normalizeStockUniverse([{
  name: 'Acme xStock', symbol: 'ACMEx',
  underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
  deployments: [{ address: mint, network: 'Solana' }],
}], [], '2026-09-25T00:00:00.000Z')[0]).variant;
const variants = new Map([[mint, variant]]);
const signal = new AbortController().signal;

describe('Phase 6 keyless Jupiter batch adapter', () => {
  beforeEach(() => vi.mocked(jupiterJson).mockReset());

  it('requests exact mints keylessly and treats an omitted mint as unavailable, not zero', async () => {
    vi.mocked(jupiterJson).mockResolvedValueOnce({});
    expect(await readJupiterPriceV3Batch({ mints: [mint], variants, signal }))
      .toEqual({ status: 'ok', observations: [] });
    expect(jupiterJson).toHaveBeenCalledWith(`/price/v3?ids=${mint}`, expect.anything(), signal,
      'keyless-global-market', 'price_worker', { retryRateLimit: false });
  });

  it('keeps the original exact-mint token unit and omits an incompatible mint without failing the batch', async () => {
    vi.mocked(jupiterJson).mockResolvedValueOnce({ [mint]: { usdPrice: 12.5, blockId: 1,
      decimals: 8, priceChange24h: 1.2 } });
    const result = await readJupiterPriceV3Batch({ mints: [mint], variants, signal });
    expect(result).toMatchObject({ status: 'ok', observations: [{ mint, price: '12.5',
      unit: { kind: 'token-unit', id: `token:${mint}` }, providerObservedAt: null }] });
    const knownDecimals = new Map([[mint, { ...variant, decimals: 6 }]]);
    vi.mocked(jupiterJson).mockResolvedValueOnce({ [mint]: { usdPrice: 12.5, blockId: 1, decimals: 8 } });
    expect(await readJupiterPriceV3Batch({ mints: [mint], variants: knownDecimals, signal }))
      .toEqual({ status: 'ok', observations: [] });
  });

  it('maps Retry-After into the coordinator contract and rejects an unexpected mint', async () => {
    vi.mocked(jupiterJson).mockRejectedValueOnce(new JupiterApiError('rate-limited', 429, '429', 7));
    expect(await readJupiterPriceV3Batch({ mints: [mint], variants, signal }))
      .toEqual({ status: 'rate-limited', retryAfterMs: 7_000 });
    vi.mocked(jupiterJson).mockResolvedValueOnce({ invalidMint: { usdPrice: 10, blockId: 1, decimals: 8 } });
    expect(await readJupiterPriceV3Batch({ mints: [mint], variants, signal }))
      .toEqual({ status: 'failed' });
  });

  it('rejects oversized or duplicate batches before any provider call', async () => {
    await expect(readJupiterPriceV3Batch({ mints: [mint, mint], variants, signal })).rejects.toThrow();
    await expect(readJupiterPriceV3Batch({ mints: Array.from({ length: 51 }, () => mint), variants, signal })).rejects.toThrow();
    expect(jupiterJson).not.toHaveBeenCalled();
  });
});
