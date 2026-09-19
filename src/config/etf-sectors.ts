import type { EtfSnapshot } from '@/domain/types';

// State Street's official SPY fund-sector breakdown, as displayed on its fund page.
// It is intentionally dated independently from the daily constituent workbook.
export const spySectorAllocation: NonNullable<EtfSnapshot['sectorAllocation']> = {
  asOf: '2026-09-10', coverageWeight: '0.9999',
  source: { id: 'ssga-spy-sectors-2026-09-10', label: 'State Street SPY fund sector breakdown',
    url: 'https://www.ssga.com/us/en/intermediary/etfs/state-street-spdr-sp-500-etf-trust-spy',
    observedAt: '2026-09-10T00:00:00.000Z', retrievedAt: '2026-09-14T05:29:20.552Z',
    slot: null, endSlot: null, kind: 'issuer-snapshot', validity: 'valid' },
  allocations: [
    { name:'Information Technology', weight:'0.3815' },
    { name:'Financials', weight:'0.1226' },
    { name:'Communication Services', weight:'0.0970' },
    { name:'Health Care', weight:'0.0913' },
    { name:'Consumer Discretionary', weight:'0.0891' },
    { name:'Industrials', weight:'0.0819' },
    { name:'Consumer Staples', weight:'0.0448' },
    { name:'Energy', weight:'0.0359' },
    { name:'Utilities', weight:'0.0202' },
    { name:'Materials', weight:'0.0178' },
    { name:'Real Estate', weight:'0.0178' },
  ],
};
