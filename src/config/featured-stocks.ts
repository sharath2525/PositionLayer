export type FeaturedXstock = {
  name: string;
  symbol: string;
  underlyingSymbol: string;
  underlyingIsin: string;
  mint: string;
  assetClass: 'stock' | 'etf';
  verifiedAt: string;
};

// Exact issuer records checked against the xStocks public registry. This small,
// reviewed universe keeps the public market page useful on free keyless limits
// without inferring identity or asset type from a name or ticker.
export const featuredXstocks: readonly FeaturedXstock[] = [
  { name: 'NVIDIA xStock', symbol: 'NVDAx', underlyingSymbol: 'NVDA', underlyingIsin: 'US67066G1040', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', assetClass: 'stock', verifiedAt: '2026-09-14T00:00:00.000Z' },
  { name: 'Tesla xStock', symbol: 'TSLAx', underlyingSymbol: 'TSLA', underlyingIsin: 'US88160R1014', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', assetClass: 'stock', verifiedAt: '2026-09-14T00:00:00.000Z' },
  { name: 'SP500 xStock', symbol: 'SPYx', underlyingSymbol: 'SPY', underlyingIsin: 'US78462F1030', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', assetClass: 'etf', verifiedAt: '2026-09-14T00:00:00.000Z' },
  { name: 'Nasdaq xStock', symbol: 'QQQx', underlyingSymbol: 'QQQ', underlyingIsin: 'US46090E1038', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', assetClass: 'etf', verifiedAt: '2026-09-14T00:00:00.000Z' },
  { name: 'Alphabet xStock', symbol: 'GOOGLx', underlyingSymbol: 'GOOGL', underlyingIsin: 'US02079K3059', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', assetClass: 'stock', verifiedAt: '2026-09-14T00:00:00.000Z' },
  { name: 'Nike xStock', symbol: 'NKEx', underlyingSymbol: 'NKE', underlyingIsin: 'US6541061031', mint: 'XsGYpMvKbVt6ViHqRd7cF3s746dAMFBQWcC49hB9VVP', assetClass: 'stock', verifiedAt: '2026-09-14T00:00:00.000Z' },
] as const;
