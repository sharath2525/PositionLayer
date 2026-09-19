import type { Instrument } from "@/domain/types";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const VAULT_PROGRAM = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const xstock = (id: string, mint: string, name: string, securityId: string, companyId: string | null, fundId: "SPY" | "QQQ" | null): Instrument => ({
  id, mint, symbol: id, name, securityId, companyId, fundId,
  issuer: "Backed Assets (JE) Limited", chain: "solana:mainnet", kind: fundId ? "etf" : "stock",
  decimals: 8, tokenProgram: TOKEN_2022_PROGRAM, amountConvention: "scaled-ui",
  identitySource: `https://api.xstocks.fi/api/v2/public/assets/${id}`,
});
// Issuer metadata + onchain mint owner/decimals verified at slot 446488248.
// Identity is always (chain, mint, token program, decimals), never a symbol match.
export const instruments: Instrument[] = [
  xstock("NVDAx", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", "NVIDIA", "US67066G1040", "NVIDIA", null),
  xstock("TSLAx", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "Tesla", "US88160R1014", "TESLA", null),
  xstock("SPYx", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "S&P 500", "US78462F1030", null, "SPY"),
  xstock("QQQx", "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", "Nasdaq-100", "US46090E1038", null, "QQQ"),
  { id: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin", securityId: "circle:USDC", companyId: null, fundId: null, issuer: "Circle", chain: "solana:mainnet", kind: "cash", decimals: 6, tokenProgram: TOKEN_PROGRAM, amountConvention: "unscaled", identitySource: "https://developers.circle.com/stablecoins/usdc-contract-addresses" },
  { id: "SOL", mint: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Solana", securityId: "solana:SOL", companyId: null, fundId: null, issuer: "Solana", chain: "solana:mainnet", kind: "crypto", decimals: 9, tokenProgram: TOKEN_PROGRAM, amountConvention: "unscaled", identitySource: "https://developers.jup.ag/docs/lend/borrow/api" },
];
export const byId = Object.fromEntries(instruments.map(i => [i.id, i]));
export function identify(chain: string, mint: string, tokenProgram: string, decimals: number): Instrument | undefined {
  return instruments.find(i => i.chain === chain && i.mint === mint && i.tokenProgram === tokenProgram && i.decimals === decimals);
}
// Discovery evidence only; each live read must revalidate vault config and owner.
export const verifiedVaults = [
  { vaultId: 1, instrumentId: "SOL" },
  { vaultId: 77, instrumentId: "TSLAx" }, { vaultId: 78, instrumentId: "SPYx" },
  { vaultId: 79, instrumentId: "QQQx" }, { vaultId: 80, instrumentId: "NVDAx" },
];
