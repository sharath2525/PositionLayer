import { decimal, sum } from "@/domain/amounts";
import { companyForSecurity, sectorMap } from "@/config/companies";
import { EtfSchema, type EtfSnapshot } from "@/domain/types";

export type SpyRow = { name: string; ticker: string; identifier: string; weightPercent: string };
export function parseSpyRows(rows: SpyRow[], holdingsDate: string, retrievedAt: string, checksum: string): EtfSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holdingsDate) || rows.length < 490) throw Error('Expected a dated full SPY holdings snapshot');
  const seen = new Set<string>();
  const constituents = rows.map(row => {
    if (seen.has(row.identifier)) throw Error(`Duplicate SPY security ${row.identifier}`);
    seen.add(row.identifier);
    const weight = decimal(row.weightPercent).div(100);
    if (weight.lt(0) || weight.gt(1)) throw Error('Invalid holding weight');
    const companyId = companyForSecurity(row.ticker, row.identifier);
    return { securityId: row.identifier, ticker: row.ticker, name: row.name, weight: weight.toFixed(), companyId, sector: companyId ? sectorMap[companyId] || null : null };
  });
  const total = sum(constituents.map(c => c.weight));
  if (decimal(total).lt('0.99') || decimal(total).gt('1.001')) throw Error('SPY weights fail full-fund reconciliation');
  return EtfSchema.parse({
    id: `SPY-${holdingsDate}-${checksum.slice(0,12)}`, fundId: 'SPY', holdingsDate, checksum,
    status: 'complete', reportedWeight: total, residualWeight: decimal('1').sub(total).toFixed(),
    coverageWeight: sum(constituents.filter(c => c.companyId).map(c => c.weight)),
    source: { id: `ssga-spy-${holdingsDate}`, label: 'State Street daily full holdings',
      url: 'https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx',
      observedAt: `${holdingsDate}T00:00:00.000Z`, retrievedAt, slot: null, endSlot: null, kind: 'issuer-snapshot', validity: 'valid' },
    note: 'Weights copied from the dated issuer workbook. Signed rounding/cash residual is retained. Workbook sectors are blank; PositionLayer sector map v1 classifies NVIDIA and Tesla only. Date has daily granularity; midnight is a serialization convention, not a price observation.',
    constituents,
  });
}
