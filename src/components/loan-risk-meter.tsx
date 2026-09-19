import type { ReactNode } from 'react';
import { AlertTriangle, ChartPie, CircleCheck, HeartPulse, ShieldAlert, ShieldCheck, TrendingDown } from 'lucide-react';
import { decimal } from '@/domain/amounts';
import type { LoanRiskMeter as Risk } from '@/domain/loan-risk';
import { percent } from './format';

const labels: Record<Risk['state'], string> = {
  'no-debt': 'No debt',
  'within-borrow-range': 'Within borrow range',
  'above-borrow-limit': 'Above maximum-borrow LTV',
  'threshold-reached': 'Liquidation threshold reached',
  unavailable: 'Risk unavailable',
};

const ARC_PATH = 'M 32 204 A 178 178 0 0 1 388 204';
const ARC_CENTER = 210;
const ARC_BASELINE = 204;
const ARC_RADIUS = 178;

function gaugePercent(value: string | null) {
  if (value === null) return null;
  try { return Number(decimal(value).mul(100).clamp(0, 100).toFixed(4)); }
  catch { return null; }
}

function arcPoint(value: number, radius = ARC_RADIUS) {
  const angle = Math.PI - (value / 100) * Math.PI;
  return {
    x: ARC_CENTER + radius * Math.cos(angle),
    y: ARC_BASELINE - radius * Math.sin(angle),
  };
}

function ArcSegment({ start, end, className }: { start: number; end: number; className: string }) {
  const length = Math.max(0, end - start);
  return <path className={className} d={ARC_PATH} pathLength={100} strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start}/>;
}

function ArcDivider({ position }: { position: number }) {
  const inner = arcPoint(position, ARC_RADIUS - 13);
  const outer = arcPoint(position, ARC_RADIUS + 13);
  return <line className="risk-arc-divider" x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}/>;
}

function BoundaryMarker({ position, kind }: { position: number; kind: 'borrow' | 'liquidation' }) {
  const inner = arcPoint(position, ARC_RADIUS - 18);
  const outer = arcPoint(position, ARC_RADIUS + 11);
  return <g className={`risk-threshold-marker ${kind}`} data-position={position.toFixed(4)}>
    <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}/>
  </g>;
}

function PositionMarker({ position, kind }: { position: number; kind: 'current' | 'stressed' }) {
  const inner = arcPoint(position, ARC_RADIUS - 18);
  const point = arcPoint(position, ARC_RADIUS);
  const outer = arcPoint(position, ARC_RADIUS + 10);
  return <g className={`risk-position-marker ${kind}`} data-position={position.toFixed(4)}>
    <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}/>
    {kind === 'current'
      ? <circle cx={point.x} cy={point.y} r={7}/>
      : <rect x={point.x - 5.5} y={point.y - 5.5} width={11} height={11} transform={`rotate(45 ${point.x} ${point.y})`}/>}
  </g>;
}

function stateIcon(risk: Risk, size = 16) {
  if (risk.state === 'unavailable') return <AlertTriangle size={size}/>;
  if (risk.state === 'threshold-reached') return <ShieldAlert size={size}/>;
  if (risk.state === 'no-debt') return <CircleCheck size={size}/>;
  return <ShieldCheck size={size}/>;
}

function explanation(risk: Risk) {
  if (risk.state === 'unavailable') return 'Risk cannot be calculated until the protocol values and source checks below are resolved.';
  if (risk.state === 'no-debt') return 'This position has no outstanding debt and no current liquidation risk from borrowing.';
  if (risk.state === 'threshold-reached') return 'Current LTV has reached or exceeded the protocol liquidation threshold.';
  const buffer = risk.collateralDeclineToLiquidation === null ? '—' : percent(risk.collateralDeclineToLiquidation, 2);
  if (risk.state === 'above-borrow-limit') return `New borrowing is outside the maximum-borrow range. ${buffer} collateral decline remains before the liquidation threshold.`;
  return `Collateral can decline ${buffer} before the position reaches the liquidation threshold.`;
}

function RiskMetricCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return <div className="risk-metric-card">
    <span className="risk-metric-icon">{icon}</span>
    <div><span>{label}</span><strong>{value}</strong></div>
    <p>{detail}</p>
  </div>;
}

export function LoanRiskMeter({ risk, showStress = false }: { risk: Risk; showStress?: boolean }) {
  const borrow = gaugePercent(risk.maxBorrowLtv) ?? 0;
  const threshold = gaugePercent(risk.liquidationThreshold) ?? 100;
  const current = gaugePercent(risk.currentLtv);
  const stressed = showStress ? gaugePercent(risk.stressedLtv) : null;
  const permittedRangeEnd = Math.min(borrow, threshold);
  // The two green arcs evenly divide the protocol's permitted borrowing range;
  // this is visual segmentation only and does not create another risk threshold.
  const safeVisualEnd = permittedRangeEnd / 2;
  const boundaryValue = risk.liquidationBoundaryUsed === null ? '—' : percent(risk.liquidationBoundaryUsed, 2);
  const declineValue = risk.collateralDeclineToLiquidation === null ? '—' : percent(risk.collateralDeclineToLiquidation, 2);
  const healthValue = risk.healthFactor === null ? '—' : decimal(risk.healthFactor).toDecimalPlaces(3).toFixed();
  const accessible = `Current LTV ${risk.currentLtv === null ? 'unavailable' : percent(risk.currentLtv, 2)}. Maximum-borrow LTV ${percent(risk.maxBorrowLtv, 2)}. Liquidation threshold ${percent(risk.liquidationThreshold, 2)}.${showStress && risk.stressedLtv !== null ? ` Hypothetical stressed LTV ${percent(risk.stressedLtv, 2)}.` : ''}`;

  return <section className={`risk-meter risk-${risk.state}`} aria-label={`Loan risk: ${labels[risk.state]}`}>
    <div className="risk-layout">
      <div className="risk-visual">
        <div className="risk-dial">
          <svg viewBox="0 0 420 235" role="img" aria-label={accessible}>
            <title>{accessible}</title>
            <path className="risk-arc-base" d={ARC_PATH}/>
            <ArcSegment className="risk-arc-segment safe" start={0} end={safeVisualEnd}/>
            <ArcSegment className="risk-arc-segment watch" start={safeVisualEnd} end={permittedRangeEnd}/>
            <ArcSegment className="risk-arc-segment high" start={permittedRangeEnd} end={threshold}/>
            <ArcSegment className="risk-arc-segment critical" start={threshold} end={100}/>
            <ArcDivider position={safeVisualEnd}/>
            <ArcDivider position={borrow}/>
            <ArcDivider position={threshold}/>
            <BoundaryMarker position={borrow} kind="borrow"/>
            <BoundaryMarker position={threshold} kind="liquidation"/>
            {current !== null && <PositionMarker position={current} kind="current"/>}
            {stressed !== null && <PositionMarker position={stressed} kind="stressed"/>}
          </svg>
          <div className="risk-dial-center" aria-hidden="true">
            <strong>{risk.currentLtv === null ? '—' : percent(risk.currentLtv, 2)}</strong>
            <span>LTV</span>
            <b>{stateIcon(risk, 17)}{labels[risk.state]}</b>
          </div>
        </div>
        <div className="risk-boundary-legend">
          <span>0% LTV</span>
          <span><b>B</b> Borrow {percent(risk.maxBorrowLtv, 2)}</span>
          <span><b>T</b> Liquidation {percent(risk.liquidationThreshold, 2)}</span>
          <span>100%</span>
        </div>
        <div className="risk-explanation">{stateIcon(risk, 17)}<span>{explanation(risk)}</span></div>
        {stressed !== null && <div className="risk-stress-note"><i/>Hypothetical stress marker: {risk.stressedLtv === null ? '—' : percent(risk.stressedLtv, 2)} LTV</div>}
      </div>

      <div className="risk-metrics">
        <RiskMetricCard icon={<ChartPie size={22}/>} label="Boundary used" value={boundaryValue} detail={risk.liquidationBoundaryUsed === null ? 'Unavailable until protocol values pass validation.' : `Uses ${boundaryValue} of the liquidation threshold.`}/>
        <RiskMetricCard icon={<TrendingDown size={22}/>} label="Decline buffer" value={declineValue} detail={risk.collateralDeclineToLiquidation === null ? 'Unavailable until protocol values pass validation.' : `Collateral can decline ${declineValue} before liquidation.`}/>
        <RiskMetricCard icon={<HeartPulse size={22}/>} label="Health factor" value={healthValue} detail={risk.healthFactor === null ? risk.state === 'no-debt' ? 'No debt; health factor is not applicable.' : 'Unavailable until protocol values pass validation.' : risk.state === 'threshold-reached' ? 'At or below the liquidation safety threshold.' : 'Above the liquidation threshold baseline of 1.0.'}/>
      </div>
    </div>
    {risk.state === 'unavailable' && <ul className="risk-blockers">{risk.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
  </section>;
}
