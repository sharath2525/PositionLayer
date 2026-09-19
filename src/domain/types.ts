import { z } from "zod";

export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);
export const unsignedDecimal = decimalString.refine(v => !v.startsWith("-"), "Must be nonnegative");
export const rawString = z.string().regex(/^\d+$/);
export const SourceSchema = z.object({
  id: z.string(), label: z.string(), url: z.string().url().nullable(),
  observedAt: z.string().datetime(), retrievedAt: z.string().datetime(),
  slot: z.number().int().nonnegative().nullable(), endSlot: z.number().int().nonnegative().nullable(),
  kind: z.enum(["live", "issuer-snapshot", "sample", "hypothetical"]),
  validity: z.enum(["valid", "stale", "unverified"]),
});
export type Source = z.infer<typeof SourceSchema>;
export type Instrument = {
  id: string; chain: "solana:mainnet"; mint: string; symbol: string; name: string;
  issuer: string; securityId: string; companyId: string | null; fundId: "SPY" | "QQQ" | null;
  kind: "stock" | "etf" | "cash" | "crypto"; decimals: number; tokenProgram: string;
  amountConvention: "scaled-ui" | "unscaled"; identitySource: string;
};
export const CapabilitySchema = z.object({
  positionReadable: z.boolean(), exposureAvailable: z.boolean(), reason: z.string(),
});
export type Capabilities = z.infer<typeof CapabilitySchema>;
export const MintStateSchema = z.object({
  mint: z.string(), decimals: z.number().int(), tokenProgram: z.string(),
  multiplier: unsignedDecimal, pendingMultiplier: unsignedDecimal.nullable(), effectiveAt: z.number().int().nullable(),
  chainTime: z.number().int(), source: SourceSchema,
});
export type MintState = z.infer<typeof MintStateSchema>;
export const PriceSchema = z.object({
  instrumentId: z.string(), value: unsignedDecimal, currency: z.enum(["USD", "USDC"]),
  basis: z.enum(["reference", "protocol", "quote"]),
  per: z.enum(["display-token", "unscaled-token"]),
  multiplier: unsignedDecimal.nullable(), source: SourceSchema,
});
export type PriceObservation = z.infer<typeof PriceSchema>;
export const ValueSchema = z.object({
  amount: decimalString, currency: z.enum(["USD", "USDC"]),
  basis: z.enum(["reference", "protocol", "quote"]), source: SourceSchema,
});
export type ValueObservation = z.infer<typeof ValueSchema>;
export const HoldingSchema = z.object({
  id: z.string(), owner: z.string(), instrumentId: z.string(),
  scope: z.enum(["wallet", "deposited"]), accountIds: z.array(z.string()), positionId: z.string().nullable(),
  rawAmount: rawString, rawUnit: z.enum(["token-base-unit", "protocol-1e9"]), decimals: z.number().int(),
  unscaledAmount: unsignedDecimal, displayAmount: unsignedDecimal, spendable: z.boolean(),
  spendableRawAmount: rawString, spendableAmount: unsignedDecimal,
  mintState: MintStateSchema, source: SourceSchema, referenceValue: ValueSchema.nullable(),
});
export type Holding = z.infer<typeof HoldingSchema>;
export const LoanSchema = z.object({
  id: z.string(), protocol: z.literal("Jupiter Lend"), vaultId: z.number().int(), positionId: z.number().int(),
  owner: z.string(), positionAddress: z.string(), positionMint: z.string(),
  collateralInstrumentId: z.string(), debtInstrumentId: z.string(),
  collateralAccountingRaw: rawString, debtAccountingRaw: rawString, accountingDecimals: z.literal(9),
  collateralUnscaled: unsignedDecimal, debtUnscaled: unsignedDecimal,
  collateralValue: ValueSchema.nullable(), debtValue: ValueSchema.nullable(),
  ltv: unsignedDecimal.nullable(), liquidationThreshold: unsignedDecimal,
  maxBorrowLtv: unsignedDecimal, liquidationPenalty: unsignedDecimal,
  isLiquidated: z.boolean(), source: SourceSchema, capabilities: CapabilitySchema,
});
export type Loan = z.infer<typeof LoanSchema>;
export const WalletAssetSchema = z.object({
  id: z.string(), owner: z.string(), mint: z.string(), symbol: z.string(), name: z.string(),
  tokenProgram: z.string(), decimals: z.number().int().nonnegative(), accountCount: z.number().int().positive(),
  rawAmount: rawString, unscaledAmount: unsignedDecimal.nullable().optional(), amount: unsignedDecimal.nullable(), spendableAmount: unsignedDecimal.nullable(),
  verification: z.enum(["verified", "unverified", "suspicious"]),
  assetClass: z.enum(["stock", "etf", "cash", "crypto", "other"]).optional(),
  companyId: z.string().nullable().optional(), sector: z.string().nullable().optional(),
  securityId: z.string().nullable().optional(), identitySource: z.string().url().nullable().optional(),
  underlyingSymbol: z.string().nullable().optional(), logoUrl: z.string().url().regex(/^https:\/\//).nullable().optional(),
  amountConvention: z.enum(["base-decimals", "scaled-ui", "interest-bearing", "unresolved"]).optional(),
  referenceValue: ValueSchema.nullable(), source: SourceSchema,
});
export type WalletAsset = z.infer<typeof WalletAssetSchema>;
export const EarnPositionSchema = z.object({
  id: z.string(), owner: z.string(), receiptMint: z.string(), assetMint: z.string(),
  symbol: z.string(), name: z.string(), decimals: z.number().int().nonnegative(),
  logoUrl: z.string().url().regex(/^https:\/\//).nullable().optional(),
  rawUnderlying: rawString, amount: unsignedDecimal, apy: unsignedDecimal.nullable(),
  referenceValue: ValueSchema.nullable(), link: z.string().url(), source: SourceSchema,
});
export type EarnPosition = z.infer<typeof EarnPositionSchema>;
export const UnmodeledLoanSchema = z.object({
  id: z.string(), owner: z.string(), vaultId: z.number().int(), positionId: z.number().int(),
  collateralMint: z.string(), collateralSymbol: z.string(), collateralName: z.string(),
  collateralLogoUrl: z.string().url().regex(/^https:\/\//).nullable(),
  debtMint: z.string(), debtSymbol: z.string(), debtName: z.string(),
  debtLogoUrl: z.string().url().regex(/^https:\/\//).nullable(), collateralAmount: unsignedDecimal,
  debtAmount: unsignedDecimal, collateralValueUsd: unsignedDecimal.nullable(), debtValueUsd: unsignedDecimal.nullable(),
  liquidationThreshold: unsignedDecimal.nullable(), reason: z.string(), link: z.string().url(), source: SourceSchema,
});
export type UnmodeledLoan = z.infer<typeof UnmodeledLoanSchema>;
export const IndexedPositionSchema = z.object({
  id: z.string(), type: z.string(), platformId: z.string(), label: z.string(), name: z.string().nullable(),
  valueUsd: decimalString, netApy: decimalString.nullable(), link: z.string().url().nullable(), source: SourceSchema,
});
export type IndexedPosition = z.infer<typeof IndexedPositionSchema>;
export const EtfSchema = z.object({
  id: z.string(), fundId: z.enum(["SPY", "QQQ"]), holdingsDate: z.string().nullable(),
  source: SourceSchema, status: z.enum(["complete", "partial", "unavailable"]),
  checksum: z.string().nullable(), reportedWeight: decimalString, residualWeight: decimalString,
  coverageWeight: unsignedDecimal, note: z.string(),
  sectorAllocation: z.object({
    asOf: z.string(), coverageWeight: unsignedDecimal, source: SourceSchema,
    allocations: z.array(z.object({ name: z.string(), weight: unsignedDecimal })),
  }).nullable().optional(),
  constituents: z.array(z.object({ securityId: z.string(), ticker: z.string(), name: z.string(),
    companyId: z.string().nullable(), sector: z.string().nullable(), weight: unsignedDecimal })),
});
export type EtfSnapshot = z.infer<typeof EtfSchema>;
export const PortfolioSchema = z.object({
  id: z.string(), mode: z.enum(["live", "sample"]), owner: z.string().nullable(), cluster: z.literal("solana:mainnet"),
  observedAt: z.string().datetime(), holdings: z.array(HoldingSchema), loans: z.array(LoanSchema),
  prices: z.array(PriceSchema), etfs: z.array(EtfSchema),
  walletAssets: z.array(WalletAssetSchema).optional(), earnPositions: z.array(EarnPositionSchema).optional(),
  unmodeledLoans: z.array(UnmodeledLoanSchema).optional(), indexedPositions: z.array(IndexedPositionSchema).optional(),
  unsupported: z.array(z.object({ mint: z.string(), accountCount: z.number().int(), reason: z.string() })),
  issues: z.array(z.string()), loanRead: z.enum(["ready", "partial", "blocked", "error"]),
  capabilities: z.record(z.string(), CapabilitySchema),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;
export const PortfolioResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), data: PortfolioSchema }),
  z.object({ status: z.literal("partial"), data: PortfolioSchema }),
  z.object({ status: z.literal("stale"), data: PortfolioSchema }),
  z.object({ status: z.literal("empty"), data: PortfolioSchema }),
  z.object({ status: z.literal("error"), message: z.string(), code: z.string() }),
]);
export type PortfolioResult = z.infer<typeof PortfolioResultSchema>;
export type PositionSelection = { vaultId: number; positionId: number };
export interface PortfolioProvider { read(owner: string | null, signal?: AbortSignal, selection?: PositionSelection): Promise<PortfolioResult> }
