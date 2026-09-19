import spy from '../../../data/holdings/spy.json';
import { EtfSchema, type EtfSnapshot } from '@/domain/types';
import { spySectorAllocation } from '@/config/etf-sectors';
export function holdingsSnapshots(): EtfSnapshot[] {
  return [EtfSchema.parse({ ...spy, sectorAllocation: spySectorAllocation }), {
    id: 'QQQ-unavailable-2026-09-12', fundId: 'QQQ', holdingsDate: null, status: 'unavailable', checksum: null,
    reportedWeight: '0', residualWeight: '1', coverageWeight: '0', constituents: [],
    sectorAllocation: null, note: 'Invesco official full holdings table could not load on September 12, 2026. QQQ is entirely undecomposed; no SPY weights are substituted.',
    source: { id: 'invesco-attempt-2026-09-12', label: 'Invesco holdings: unavailable', url: 'https://www.invesco.com/qqq-etf/en/about.html',
      observedAt: '2026-09-12T17:33:00.000Z', retrievedAt: '2026-09-12T17:33:00.000Z', kind: 'issuer-snapshot', validity: 'unverified', slot: null, endSlot: null },
  }];
}
