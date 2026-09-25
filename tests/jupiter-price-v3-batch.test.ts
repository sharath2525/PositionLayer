import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/adapters/jupiter-api/client', () => ({
  jupiterJson: vi.fn(),
  JupiterApiError: class JupiterApiError extends Error {
    constructor(public kind: string, public status: number | null, message: string,
      public retryAfterSeconds: number | null = null) { super(message); }
  },
}));
import { jupiterJson } from '@/adapters/jupiter-api/client';
import { readJupiterPriceV3Batch } from '@/adapters/market/jupiter-price-v3-batch';
import { bundledMarketV2Catalog } from '@/services/market-v2-engine';

describe('Price V3 mixed stock batches', () => {
  it('retains valid exact-mint token prices and omits stockData-only/unverified entries individually', async () => {
    const variants = bundledMarketV2Catalog().registry.entries.slice(0, 3).map(entry => entry.variant);
    const [priced, stockDataOnly, wrongDecimals] = variants;
    const verifiedWrongDecimals = { ...wrongDecimals, decimals: 8 };
    vi.mocked(jupiterJson).mockResolvedValueOnce({
      [priced.mint]: { usdPrice: 101.25, blockId: 123, decimals: priced.decimals ?? 8 },
      [stockDataOnly.mint]: { stockData: { price: 999.99 }, decimals: stockDataOnly.decimals ?? 8 },
      [wrongDecimals.mint]: { usdPrice: 12.5, blockId: 124, decimals: 9 },
    });
    const result = await readJupiterPriceV3Batch({ mints: variants.map(item => item.mint),
      variants: new Map([...variants.slice(0, 2), verifiedWrongDecimals].map(item => [item.mint, item])),
      signal: new AbortController().signal });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ mint: priced.mint, price: '101.25',
      provider: 'jupiter-price-v3', unit: { kind: 'token-unit' } });
  });
});
