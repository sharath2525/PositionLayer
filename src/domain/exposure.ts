import { byId } from '@/config/instruments';
import { companyNames, sectorMap } from '@/config/companies';
import { D, decimal, ratio, sum } from './amounts';
import type { Portfolio, EtfSnapshot } from './types';
import { verifiedStockEarnPositions } from './portfolio';

// Shared company decomposition consumed by both dollar exposure and loan stress.
export function instrumentComposition(instrumentId: string, etfs: EtfSnapshot[]) {
  const instrument = byId[instrumentId];
  const companies = new Map<string, { companyId: string; ticker: string; name: string; sector: string | null; weight: string }>();
  if (instrument?.companyId) companies.set(instrument.companyId, { companyId: instrument.companyId, ticker: instrument.symbol.replace(/x$/i,''), name: instrument.name, sector: sectorMap[instrument.companyId] || null, weight: '1' });
  const fund = instrument?.fundId ? etfs.find(e=>e.fundId===instrument.fundId) : undefined;
  if (fund && fund.status !== 'unavailable') for (const c of fund.constituents) {
    if (!c.companyId) continue;
    const previous = companies.get(c.companyId);
    companies.set(c.companyId, { companyId: c.companyId, ticker: previous?.ticker || c.ticker, name: previous?.name || c.name, sector: c.sector,
      weight: decimal(previous?.weight || '0').add(c.weight).toFixed() });
  }
  const coverage = sum([...companies.values()].map(c=>c.weight));
  const available = Boolean(instrument?.companyId || (fund && fund.status !== 'unavailable'));
  return { companies: [...companies.values()], coverage, unknownWeight: decimal('1').sub(coverage).toFixed(),
    snapshotId: fund?.id || null, source: fund?.source || null, holdingsDate: fund?.holdingsDate || null,
    status: !available ? 'unavailable' as const : fund && (fund.status === 'partial' || coverage !== '1') ? 'partial' as const : 'complete' as const };
}

export type Contribution = { holdingId: string; instrumentId: string; scope: 'wallet' | 'deposited' | 'earn'; amountUsd: string; sourceId: string; etfSnapshotId: string | null };
export type CompanyExposure = { id: string; ticker: string; name: string; sector: string | null; amountUsd: string; directUsd: string; etfUsd: string; sleeveWeight: string | null; contributions: Contribution[] };
export type SectorExposure = { name: string; amountUsd: string; directUsd: string; etfUsd: string; sleeveWeight: string | null; sourceIds: string[] };
export function exposure(portfolio: Portfolio) {
  const companies = new Map<string, CompanyExposure>();
  const sectorRows = new Map<string, { name: string; amountUsd: string; directUsd: string; etfUsd: string; sourceIds: Set<string> }>();
  let unknownCompany = new D(0); let valuedStocks = new D(0); let unvaluedStocks = 0;
  const canonicalSector = (value: string | null) => {
    if (!value) return 'Unknown / unclassified';
    const known = ['Information Technology','Financials','Communication Services','Health Care','Consumer Discretionary','Industrials','Consumer Staples','Energy','Utilities','Materials','Real Estate'];
    return known.find(name => name.toLowerCase() === value.toLowerCase()) || value;
  };
  const addSector = (name: string | null, amount: string, route: 'direct' | 'etf', sourceId: string) => {
    const key = canonicalSector(name);
    const row = sectorRows.get(key) || { name: key, amountUsd: '0', directUsd: '0', etfUsd: '0', sourceIds: new Set<string>() };
    row.amountUsd = decimal(row.amountUsd).add(amount).toFixed();
    row[route === 'direct' ? 'directUsd' : 'etfUsd'] = decimal(row[route === 'direct' ? 'directUsd' : 'etfUsd']).add(amount).toFixed();
    row.sourceIds.add(sourceId); sectorRows.set(key, row);
  };
  const add = (id: string, ticker: string, name: string, sector: string | null, contribution: Contribution) => {
    const row = companies.get(id) || { id, ticker, name: companyNames[id] || name, sector, amountUsd: '0', directUsd: '0', etfUsd: '0', sleeveWeight: null, contributions: [] };
    if (!row.sector && sector) row.sector = canonicalSector(sector);
    row.amountUsd = decimal(row.amountUsd).add(contribution.amountUsd).toFixed();
    if (contribution.etfSnapshotId) row.etfUsd = decimal(row.etfUsd).add(contribution.amountUsd).toFixed();
    else row.directUsd = decimal(row.directUsd).add(contribution.amountUsd).toFixed();
    row.contributions.push(contribution); companies.set(id, row);
  };
  for (const holding of portfolio.holdings) {
    const instrument = byId[holding.instrumentId];
    if (!instrument || !['stock','etf'].includes(instrument.kind)) continue;
    const value = holding.referenceValue;
    if (!value || value.basis !== 'reference' || value.currency !== 'USD') { unvaluedStocks++; continue; }
    valuedStocks = valuedStocks.add(value.amount);
    const contribution: Contribution = { holdingId: holding.id, instrumentId: instrument.id, scope: holding.scope,
      amountUsd: value.amount, sourceId: value.source.id, etfSnapshotId: null };
    if (instrument.companyId) {
      const sector = sectorMap[instrument.companyId] || null;
      add(instrument.companyId, instrument.symbol.replace(/x$/i,''), instrument.name, sector, contribution); addSector(sector, value.amount, 'direct', value.source.id); continue;
    }
    const composition = instrumentComposition(instrument.id, portfolio.etfs);
    const fund = instrument.fundId ? portfolio.etfs.find(item => item.fundId === instrument.fundId) : undefined;
    if (fund?.sectorAllocation) {
      let sectorKnown = new D(0);
      for (const allocation of fund.sectorAllocation.allocations) {
        const amount = decimal(value.amount).mul(allocation.weight); sectorKnown = sectorKnown.add(amount);
        addSector(allocation.name, amount.toFixed(), 'etf', fund.sectorAllocation.source.id);
      }
      addSector(null, decimal(value.amount).sub(sectorKnown).toFixed(), 'etf', fund.sectorAllocation.source.id);
    } else addSector(null, value.amount, 'etf', fund?.source.id || value.source.id);
    if (composition.status === 'unavailable') { unknownCompany = unknownCompany.add(value.amount); continue; }
    let known = new D(0);
    for (const constituent of composition.companies) {
      const amount = decimal(value.amount).mul(constituent.weight);
      known = known.add(amount);
      add(constituent.companyId, constituent.ticker, constituent.name, constituent.sector, { ...contribution, amountUsd: amount.toFixed(), etfSnapshotId: composition.snapshotId });
    }
    // Includes cash, unmapped securities and the exact signed issuer residual.
    unknownCompany = unknownCompany.add(decimal(value.amount).sub(known));
  }
  for (const asset of portfolio.walletAssets || []) {
    if (!['stock','etf'].includes(asset.assetClass || '') || asset.verification !== 'verified') continue;
    const value = asset.referenceValue;
    if (!value || value.basis !== 'reference' || value.currency !== 'USD') { unvaluedStocks++; continue; }
    valuedStocks = valuedStocks.add(value.amount);
    const contribution: Contribution = { holdingId: asset.id, instrumentId: asset.symbol, scope: 'wallet', amountUsd: value.amount,
      sourceId: value.source.id, etfSnapshotId: null };
    if (asset.assetClass === 'stock' && asset.companyId) {
      add(asset.companyId, asset.underlyingSymbol || asset.symbol.replace(/x$/i,''), asset.name, asset.sector || null, contribution); addSector(asset.sector || null, value.amount, 'direct', asset.identitySource || value.source.id);
    } else {
      unknownCompany = unknownCompany.add(value.amount); addSector(null, value.amount, 'etf', asset.identitySource || value.source.id);
    }
  }
  for (const { position, instrument } of verifiedStockEarnPositions(portfolio)) {
    const value = position.referenceValue;
    if (!value || value.basis !== 'reference' || value.currency !== 'USD') { unvaluedStocks++; continue; }
    valuedStocks = valuedStocks.add(value.amount);
    const contribution: Contribution = { holdingId: position.id, instrumentId: instrument.id, scope: 'earn',
      amountUsd: value.amount, sourceId: value.source.id, etfSnapshotId: null };
    if (instrument.companyId) {
      const sector = sectorMap[instrument.companyId] || null;
      add(instrument.companyId, instrument.symbol.replace(/x$/i,''), instrument.name, sector, contribution);
      addSector(sector, value.amount, 'direct', value.source.id); continue;
    }
    const composition = instrumentComposition(instrument.id, portfolio.etfs);
    const fund = instrument.fundId ? portfolio.etfs.find(item => item.fundId === instrument.fundId) : undefined;
    if (fund?.sectorAllocation) {
      let sectorKnown = new D(0);
      for (const allocation of fund.sectorAllocation.allocations) {
        const amount = decimal(value.amount).mul(allocation.weight); sectorKnown = sectorKnown.add(amount);
        addSector(allocation.name, amount.toFixed(), 'etf', fund.sectorAllocation.source.id);
      }
      addSector(null, decimal(value.amount).sub(sectorKnown).toFixed(), 'etf', fund.sectorAllocation.source.id);
    } else addSector(null, value.amount, 'etf', fund?.source.id || value.source.id);
    if (composition.status === 'unavailable') { unknownCompany = unknownCompany.add(value.amount); continue; }
    let known = new D(0);
    for (const constituent of composition.companies) {
      const amount = decimal(value.amount).mul(constituent.weight); known = known.add(amount);
      add(constituent.companyId, constituent.ticker, constituent.name, constituent.sector, { ...contribution, amountUsd: amount.toFixed(), etfSnapshotId: composition.snapshotId });
    }
    unknownCompany = unknownCompany.add(decimal(value.amount).sub(known));
  }
  const rows = [...companies.values()].map(c => ({ ...c, sleeveWeight: ratio(c.amountUsd, valuedStocks.toFixed()) })).sort((a,b) => decimal(b.amountUsd).comparedTo(a.amountUsd));
  if (!sectorRows.has('Unknown / unclassified')) addSector(null, '0', 'direct', 'none');
  const sectors: SectorExposure[] = [...sectorRows.values()].map(row => ({ name: row.name, amountUsd: row.amountUsd, directUsd: row.directUsd,
    etfUsd: row.etfUsd, sleeveWeight: ratio(row.amountUsd, valuedStocks.toFixed()), sourceIds: [...row.sourceIds].filter(id => id !== 'none') }))
    .sort((a,b) => decimal(b.amountUsd).comparedTo(a.amountUsd));
  const knownUsd = sum(rows.map(c => c.amountUsd));
  return { companies: rows, sectors,
    valuedStockUsd: valuedStocks.toFixed(), unknownCompanyUsd: unknownCompany.toFixed(), knownCompanyUsd: knownUsd,
    companyCoverage: ratio(knownUsd, valuedStocks.toFixed()), unvaluedStockHoldings: unvaluedStocks,
    denominator: 'Covered stock sleeve at reference USD value; includes wallet, Earn, and posted routes; excludes cash and unvalued holdings' };
}
