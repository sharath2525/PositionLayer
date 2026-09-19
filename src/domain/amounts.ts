import Decimal from "decimal.js";

// No IEEE-754 arithmetic for token quantities, money, ratios, or ETF weights.
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -60, toExpPos: 60 });
export function decimal(value: string): Decimal {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error("Expected a finite decimal string");
  return new D(value);
}
export function integer(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("Expected unsigned integer base units");
  return BigInt(value);
}
export function fromBaseUnits(raw: string, decimals: number): string {
  integer(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Unsupported decimals");
  return new D(raw).div(new D(10).pow(decimals)).toFixed();
}
export function toBaseUnits(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Unsupported decimals");
  const scaled = decimal(amount).mul(new D(10).pow(decimals));
  if (scaled.isNegative() || !scaled.isInteger()) throw new Error("Amount is negative or exceeds token precision");
  return scaled.toFixed(0);
}
export function scaledDisplay(raw: string, decimals: number, multiplier: string): string {
  if (decimal(multiplier).lte(0)) throw new Error("Multiplier must be positive");
  return decimal(fromBaseUnits(raw, decimals)).mul(multiplier).toFixed();
}
export function effectiveMultiplier(current: string, pending: string | null, effectiveAt: number | null, chainTime: number): string {
  const value = pending !== null && effectiveAt !== null && chainTime >= effectiveAt ? pending : current;
  if (decimal(value).lte(0)) throw new Error("Invalid multiplier");
  return value;
}
export function ratio(numerator: string, denominator: string): string | null {
  return decimal(denominator).gt(0) ? decimal(numerator).div(denominator).toFixed() : null;
}
export function sum(values: string[]): string { return values.reduce((a, v) => a.add(decimal(v)), new D(0)).toFixed(); }
