// PositionLayer sector map v1: application classifications, not a licensed GICS feed.
// Unlisted companies remain unclassified. Issuer workbook has '-' sectors.
export const sectorMap: Record<string, string> = {
  NVIDIA: "Information Technology", TESLA: "Consumer Discretionary",
  ALPHABET: "Communication Services", NIKE: "Consumer Discretionary",
  APPLE: "Information Technology", MICROSOFT: "Information Technology",
  AMAZON: "Consumer Discretionary", META: "Communication Services",
  SPACEX: "Industrials",
};
export const companyNames: Record<string, string> = {
  NVIDIA: "NVIDIA", TESLA: "Tesla", ALPHABET: "Alphabet", NIKE: "Nike",
  APPLE: "Apple", MICROSOFT: "Microsoft", AMAZON: "Amazon", META: "Meta Platforms",
  SPACEX: "Space Exploration Technologies",
  FOX: "Fox", NEWS_CORP: "News Corp",
};
const tickerAliases: Record<string, string> = {
  NVDA: "NVIDIA", TSLA: "TESLA", GOOG: "ALPHABET", GOOGL: "ALPHABET",
  NKE: "NIKE", AAPL: "APPLE", MSFT: "MICROSOFT", AMZN: "AMAZON", META: "META",
  SPCX: "SPACEX",
  FOX: "FOX", FOXA: "FOX", NWS: "NEWS_CORP", NWSA: "NEWS_CORP",
};
export function companyForTicker(ticker: string, securityId: string): string {
  return tickerAliases[ticker.toUpperCase()] || `security:${securityId}`;
}
export function companyForSecurity(ticker: string, securityId: string): string | null {
  if (!/^[A-Z0-9]{9}$/.test(securityId) || ticker === '-' || /CASH|USD|SSIXX/.test(ticker)) return null;
  return companyForTicker(ticker, securityId);
}
