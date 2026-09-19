/**
 * Small, deliberately exact underlying-security allowlist. xStocks currently
 * returns `underlying.type: null` for these products, so never infer the fund
 * class from an xStock token name or ticker alone.
 *
 * Primary fund/issuer references (ticker + security identifier):
 * SPY https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy
 * QQQ https://www.invesco.com/us/financial-products/etfs/product-detail?productId=QQQ&ticker=QQQ
 * GLD https://www.ssga.com/us/en/individual/etfs/spdr-gold-shares-gld
 * VTI https://advisors.vanguard.com/investments/products/vti/vanguard-total-stock-market-etf
 */
const verifiedEtfByIsin = new Map([
  ['US78462F1030', 'SPY'],
  ['US46090E1038', 'QQQ'],
  ['US78463V1070', 'GLD'],
  ['US9229087690', 'VTI'],
]);

export function isVerifiedEtfUnderlying(symbol: string | null | undefined, isin: string | null | undefined) {
  return Boolean(symbol && isin && verifiedEtfByIsin.get(isin) === symbol);
}
