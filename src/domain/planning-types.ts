import { z } from 'zod';
import { decimalString, unsignedDecimal, rawString, PortfolioSchema, SourceSchema } from './types';
import { decimal } from './amounts';
const between = (v: string, min: number, max: number) => { try { return decimal(v).gte(min) && decimal(v).lte(max); } catch { return false; } };

export const ScenarioSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('broad'), decline: unsignedDecimal.refine(v=>between(v,0,1), 'Decline must be between 0 and 100%') }),
  z.object({ kind: z.literal('company'), companyId: z.string().min(1), change: decimalString.refine(v=>between(v,-1,1), 'Company move must be between -100% and +100%') }),
]);
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;
export const ScenarioResultSchema = z.object({
  loanId: z.string(), status: z.enum(['ready','partial','blocked']),
  inputPortfolioId: z.string(), currency: z.literal('USDC'), basis: z.literal('hypothetical-from-protocol'),
  collateralNow: unsignedDecimal.nullable(), debt: unsignedDecimal.nullable(), currentLtv: unsignedDecimal.nullable(),
  collateralStressed: unsignedDecimal.nullable(), stressedLtv: unsignedDecimal.nullable(),
  modeledReturn: decimalString.nullable(), companyWeight: unsignedDecimal.nullable(), unknownWeight: decimalString,
  declineToThreshold: decimalString.nullable(), currentBreached: z.boolean(), stressedBreached: z.boolean(),
  sourceIds: z.array(z.string()), holdingsSnapshotId: z.string().nullable(),
  assumptions: z.array(z.string()), warnings: z.array(z.string()), blockers: z.array(z.string()),
});
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;
export const RepaymentPlanSchema = z.object({
  schemaVersion: z.literal(2), id: z.string(), mode: z.enum(['sample','live']), owner: z.string().nullable(), cluster: z.literal('solana:mainnet'),
  status: z.enum(['ready','partial','blocked','not-needed']), executable: z.literal(false),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  inputKey: z.string(), inputSnapshot: PortfolioSchema, sources: z.array(SourceSchema), calendarId: z.string(),
  positionId: z.string(), target: z.string(), targetBasis: z.enum(['current','stressed']),
  scenario: ScenarioSpecSchema, result: ScenarioResultSchema,
  currency: z.literal('USDC'), amountUnit: z.literal('USDC-base-unit'), decimals: z.literal(6),
  repaymentBaseUnits: rawString.nullable(), repaymentUsdc: unsignedDecimal.nullable(),
  availableUsdc: unsignedDecimal.nullable(), cashCoverage: unsignedDecimal.nullable(), remainingCashUsdc: decimalString.nullable(), shortfallUsdc: unsignedDecimal.nullable(),
  expectedDebtUsdc: unsignedDecimal.nullable(), expectedCurrentLtv: unsignedDecimal.nullable(), expectedScenarioLtv: unsignedDecimal.nullable(),
  stockQuantityChanges: z.literal(false), netEquityChangeBeforeFeesUsdc: z.literal('0'),
  assumptions: z.array(z.string()), warnings: z.array(z.string()), blockers: z.array(z.string()),
});
export type RepaymentPlan = z.infer<typeof RepaymentPlanSchema>;
