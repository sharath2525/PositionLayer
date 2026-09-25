import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createXstocksIssuerReader } from '@/adapters/market/xstocks-issuer';
import { createJupiterStocksDiscovery } from '@/adapters/market/jupiter-discovery';
import { JupiterApiError } from '@/adapters/jupiter-api/client';
import { ProviderCandidateSchema, ProviderReadResultSchema } from '@/domain/market-provider';

const start = Date.parse('2026-09-24T12:00:00.000Z');
const mintA = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const mintB = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const tokenProgram = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const asset = (mint: string) => ({
  name: 'Acme xStock', symbol: 'ACMEx',
  underlying: { symbol: 'ACME', isin: 'US0000000001', type: 'Equity', listingCountry: 'US' },
  deployments: [{ address: mint, network: 'Solana' }],
});
const page = (number: number, nodes: unknown[], hasNextPage = false) =>
  Response.json({ nodes, page: { currentPage: number, hasNextPage } });
const token = (mint: string) => ({
  id: mint, name: 'Acme index listing', symbol: 'ACMEx', decimals: 8, tokenProgram,
  usdPrice: 12, liquidity: 100, mcap: 1200, stats24h: null,
});

describe('Phase 2 bounded optional market providers', () => {
  it('pages xStocks by 100, validates exact Solana issuer evidence, and deduplicates callers', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get('network')).toBe('Solana');
      expect(url.searchParams.get('listingCountry')).toBe('US');
      expect(url.searchParams.get('pageSize')).toBe('100');
      return url.searchParams.get('page') === '0' ? page(0, [asset(mintA)], true)
        : page(1, [asset(mintB)]);
    });
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => start });
    const [first, concurrent] = await Promise.all([reader.read(), reader.read()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first).toEqual(concurrent);
    expect(first.status).toBe('ready');
    expect(first.records.map(row => row.variant.mint)).toEqual([mintA, mintB]);
    expect(first.records.every(row => row.variant.verification === 'issuer-confirmed' && row.supply === null)).toBe(true);
    expect(first.records.every(row => row.variant.eligibility === 'eligible')).toBe(true);
    expect(first.records[0].variant.evidence[0]).toMatchObject({ provider: 'xstocks', exactMint: mintA });
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ProviderReadResultSchema.safeParse(first).success).toBe(true);
  });

  it('honors conditional ETag, retaining validated pages on 304', async () => {
    let time = start;
    const headers: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = new Headers(init?.headers).get('if-none-match');
      headers.push(sent ?? '');
      return sent ? new Response(null, { status: 304 })
        : Response.json({ nodes: [asset(mintA)], page: { currentPage: 0, hasNextPage: false } }, { headers: { etag: '"v1"' } });
    });
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => time });
    expect((await reader.read()).records).toHaveLength(1);
    time += 60 * 60_000 + 1;
    expect((await reader.read()).records).toHaveLength(1);
    expect(headers).toEqual(['', '"v1"']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains a previous complete issuer snapshot after a page failure, with original success time', async () => {
    let time = start;
    let failing = false;
    const fetcher = vi.fn(async () => failing ? new Response(null, { status: 503 }) : page(0, [asset(mintA)]));
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, sleep: async () => {}, now: () => time });
    const original = await reader.read();
    expect(original.status).toBe('ready');
    failing = true;
    time += 60 * 60_000 + 1;
    const stale = await reader.read();
    expect(stale.status).toBe('stale');
    expect(stale.records).toEqual(original.records);
    expect(stale.lastSuccess).toBe(original.lastSuccess);
    expect(stale.lastAttempt).not.toBe(original.lastAttempt);
    expect(stale.issues).toContain('RETAINED_LAST_GOOD');
    expect(fetcher).toHaveBeenCalledTimes(3); // initial + two bounded 503 attempts
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(3); // cooldown, no visitor amplification
  });

  it('expires last-good issuer data after its bounded stale window and recovers on a complete refresh', async () => {
    let time = start;
    let failing = false;
    const fetcher = vi.fn(async () => failing ? new Response(null, { status: 503 }) : page(0, [asset(mintA)]));
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, sleep: async () => {}, now: () => time });
    const initial = await reader.read();
    failing = true;
    time += 60 * 60_000 + 1;
    expect((await reader.read()).status).toBe('stale');
    time += 24 * 60 * 60_000;
    expect(await reader.read()).toMatchObject({ status: 'unavailable', records: [] });
    failing = false;
    time += 5 * 60_000 + 1;
    const recovered = await reader.read();
    expect(recovered.status).toBe('ready');
    expect(recovered.records.map(row => row.variant.mint)).toEqual(initial.records.map(row => row.variant.mint));
    expect(recovered.lastSuccess).not.toBe(initial.lastSuccess);
  });

  it('excludes non-US and non-Solana xStocks without inferring identity', async () => {
    const nonUs = { ...asset(mintB), underlying: { ...asset(mintB).underlying, listingCountry: 'GB' } };
    const nonSolana = { ...asset(mintB), deployments: [{ address: mintB, network: 'Ethereum' }] };
    const fetcher = vi.fn(async () => page(0, [asset(mintA), nonUs, nonSolana]));
    const result = await createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => start }).read();
    expect(result.status).toBe('ready');
    expect(result.records.map(row => row.variant.mint)).toEqual([mintA]);
  });

  it('retains an exact US Solana issuer mint when the issuer omits its security class', async () => {
    const unknownClass = { ...asset(mintA), underlying: { ...asset(mintA).underlying, type: null } };
    const result = await createXstocksIssuerReader({
      fetchImpl: vi.fn(async () => page(0, [unknownClass])) as typeof fetch, now: () => start,
    }).read();
    expect(result.status).toBe('ready');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].variant).toMatchObject({ mint: mintA,
      verification: 'issuer-confirmed', productClass: 'unknown', eligibility: 'unresolved' });
  });

  it('returns explicit partial pages without treating them as a complete replacement', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).searchParams.get('page') === '0'
      ? page(0, [asset(mintA)], true) : new Response(null, { status: 503 }));
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, sleep: async () => {}, now: () => start });
    const result = await reader.read();
    expect(result.status).toBe('partial');
    expect(result.records.map(row => row.variant.mint)).toEqual([mintA]);
    expect(result.issues).toContain('PARTIAL_PAGE');
    expect(result.lastSuccess).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('treats a validated empty page as meaningful and enforces the 25-page defensive bound', async () => {
    const empty = createXstocksIssuerReader({ fetchImpl: vi.fn(async () => page(0, [])) as typeof fetch, now: () => start });
    expect(await empty.read()).toMatchObject({ status: 'ready', records: [], issues: [] });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => page(Number(new URL(String(input)).searchParams.get('page')), [asset(mintA)], true));
    const bounded = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => start });
    const result = await bounded.read();
    expect(fetcher).toHaveBeenCalledTimes(25);
    expect(result.status).toBe('partial');
    expect(result.issues).toContain('PAGE_LIMIT');
    expect(result.records).toHaveLength(1); // one exact mint, not ten copies
  });

  it('continues verified issuer pagination beyond ten pages without a product top-N cut', async () => {
    const letters = 'ABCDEFGHJKLM';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const number = Number(new URL(String(input)).searchParams.get('page'));
      return page(number, [asset(mintA.slice(0, -1) + letters[number])], number < 11);
    });
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => start });
    const result = await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(result.status).toBe('ready');
    expect(result.records).toHaveLength(12);
  });

  it('does not retry 401, 403, invalid JSON, schema drift, or a mismatched page', async () => {
    for (const response of [
      new Response(null, { status: 401 }), new Response(null, { status: 403 }),
      new Response('{', { status: 200 }), Response.json({ broken: true }), page(1, [asset(mintA)]),
    ]) {
      const fetcher = vi.fn(async () => response.clone());
      const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, sleep: async () => {}, now: () => start });
      const result = await reader.read();
      expect(result.status).toBe('unavailable');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(1);
    }
  });

  it('honors 429 Retry-After without immediate repeat calls', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }));
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, now: () => start });
    const result = await reader.read();
    expect(result).toMatchObject({ status: 'rate-limited', retryAfter: 90, issues: ['RATE_LIMIT'] });
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a transient server error once, then recovers without changing the request budget', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(page(0, [asset(mintA)]));
    const sleep = vi.fn(async () => {});
    const reader = createXstocksIssuerReader({ fetchImpl: fetcher as typeof fetch, sleep, now: () => start });
    expect((await reader.read()).status).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    await reader.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('quarantines an invalid item and an oversized response instead of publishing a complete catalog', async () => {
    const invalid = createXstocksIssuerReader({ fetchImpl: vi.fn(async () => page(0, [asset(mintA), { symbol: 'BROKEN' }])) as typeof fetch, now: () => start });
    const partial = await invalid.read();
    expect(partial.status).toBe('partial');
    expect(partial.records).toHaveLength(1);
    expect(partial.issues).toContain('INVALID_RECORD');
    const oversized = createXstocksIssuerReader({ fetchImpl: vi.fn(async () => new Response('[]', {
      headers: { 'content-length': '2000001' },
    })) as typeof fetch, now: () => start });
    expect(await oversized.read()).toMatchObject({ status: 'unavailable', issues: ['INVALID_RESPONSE'] });
  });

  it('keeps Jupiter stocks-tag results indexed-only and one request per shared cache window', async () => {
    let time = start;
    const loadTag = vi.fn(async () => [token(mintA), token(mintA), token(mintB)]);
    const reader = createJupiterStocksDiscovery({ loadTag, now: () => time });
    const results = await Promise.all(Array.from({ length: 20 }, () => reader.read()));
    expect(loadTag).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.status === 'ready')).toBe(true);
    expect(results[0].records).toHaveLength(2);
    expect(results[0].records.every(row => row.variant.verification === 'indexed-only' && row.variant.eligibility === 'unresolved')).toBe(true);
    time += 15 * 60_000 + 1;
    await reader.read();
    expect(loadTag).toHaveBeenCalledTimes(2);
  });

  it('isolates a Jupiter 429 from the issuer adapter and retains the last indexed snapshot', async () => {
    let time = start;
    let failing = false;
    const loadTag = vi.fn(async () => {
      if (failing) throw new JupiterApiError('rate-limited', 429, 'rate limit', 90);
      return [token(mintA)];
    });
    const tag = createJupiterStocksDiscovery({ loadTag, now: () => time });
    const issuer = createXstocksIssuerReader({ fetchImpl: vi.fn(async () => page(0, [asset(mintA)])) as typeof fetch, now: () => time });
    const first = await tag.read();
    failing = true;
    time += 15 * 60_000 + 1;
    const [tagFailure, issuerSuccess] = await Promise.all([tag.read(), issuer.read()]);
    expect(tagFailure.status).toBe('stale');
    expect(tagFailure.records).toEqual(first.records);
    expect(tagFailure.lastSuccess).toBe(first.lastSuccess);
    expect(tagFailure.retryAfter).toBe(90);
    expect(issuerSuccess.status).toBe('ready');
    expect(issuerSuccess.records[0].variant.verification).toBe('issuer-confirmed');
  });

  it('retries only transient Jupiter failures and does not retry schema drift', async () => {
    const transient = vi.fn().mockRejectedValueOnce(new JupiterApiError('http', 503, 'unavailable'))
      .mockResolvedValueOnce([token(mintA)]);
    const sleep = vi.fn(async () => {});
    expect((await createJupiterStocksDiscovery({ loadTag: transient, sleep, now: () => start }).read()).status).toBe('ready');
    expect(transient).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    const malformed = vi.fn(async () => ({ unexpected: true }));
    expect((await createJupiterStocksDiscovery({ loadTag: malformed, sleep, now: () => start }).read()).status).toBe('unavailable');
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('keeps xStocks all-chain supply distinct from Solana circulating supply', async () => {
    const reader = createXstocksIssuerReader({ fetchImpl: vi.fn(async () => page(0, [asset(mintA)])) as typeof fetch, now: () => start });
    const record = (await reader.read()).records[0];
    expect(record.supply).toBeNull();
    expect(ProviderCandidateSchema.safeParse({ ...record, supply: {
      scope: 'solana-circulating', circulating: '100', total: '100', observedAt: new Date(start).toISOString(),
    } }).success).toBe(false);
    expect(ProviderCandidateSchema.safeParse({ ...record, supply: {
      scope: 'issuer-all-chain', circulating: '100', total: '100', observedAt: new Date(start).toISOString(),
    } }).success).toBe(true);
  });
});
