import { marketCalendar as calendar } from '@/config/market-calendar';

const formatter = new Intl.DateTimeFormat('en-US', { timeZone: calendar.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function localParts(now: number) {
  const p = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, year: Number(p.year), weekday: p.weekday, minute: Number(p.hour) * 60 + Number(p.minute) };
}
function sessionOn(date: string) {
  const noon = localParts(Date.parse(`${date}T16:00:00Z`));
  return { valid: noon.year === calendar.year, closed: Boolean(calendar.holidays[date]) || ['Sat','Sun'].includes(noon.weekday), close: calendar.earlyCloses[date] ?? calendar.closeMinute };
}
// Resolve local exchange time through Intl's timezone database, including DST.
function utcAt(date: string, minute: number): string {
  let utc = Date.parse(`${date}T12:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const p = localParts(utc);
    const dayDelta = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86400000;
    utc += (dayDelta * 1440 + minute - p.minute) * 60000;
  }
  return new Date(utc).toISOString();
}
export function marketSession(now: number) {
  const base = { calendarId: calendar.id, timezone: calendar.timezone, sources: calendar.sources,
    checkedAt: calendar.checkedAt, scope: 'Scheduled NYSE / Nasdaq core equity session; unscheduled halts and token markets excluded' };
  if (!Number.isFinite(now)) return { ...base, status: 'unknown' as const, label: 'Market time unavailable', nextChangeAt: null, localDate: null, earlyClose: false };
  const p = localParts(now); const day = sessionOn(p.date);
  if (!day.valid) return { ...base, status: 'unknown' as const, label: 'Calendar coverage unavailable', nextChangeAt: null, localDate: p.date, earlyClose: false };
  const open = !day.closed && p.minute >= calendar.openMinute && p.minute < day.close;
  let nextChangeAt: string | null = open ? utcAt(p.date,day.close) : null;
  if (!open) for (let i = 0; i < 10; i++) {
    const date = new Date(Date.parse(`${p.date}T12:00:00Z`) + i * 86400000).toISOString().slice(0,10);
    const candidate = sessionOn(date);
    if (candidate.valid && !candidate.closed && (i > 0 || p.minute < calendar.openMinute)) { nextChangeAt = utcAt(date,calendar.openMinute); break; }
  }
  const holiday = calendar.holidays[p.date];
  return { ...base, status: open ? 'open' as const : 'closed' as const,
    label: open ? 'Reference core session open' : holiday ? `Closed · ${holiday}` : day.closed ? 'Closed · weekend' : p.minute < calendar.openMinute ? 'Core session not yet open' : 'Core session closed',
    nextChangeAt, localDate: p.date, earlyClose: Boolean(calendar.earlyCloses[p.date]) };
}
