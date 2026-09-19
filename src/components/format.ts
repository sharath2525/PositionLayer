import { decimal, D } from '@/domain/amounts';
export function number(value: string | null | undefined, places = 2): string {
  if (value == null) return '—';
  const [whole, fraction] = decimal(value).toFixed(places).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}
export function amount(value: string | null | undefined, minimumPlaces = 2, maximumPlaces = 9): string {
  if (value == null) return '—';
  const n = decimal(value);
  if (n.isZero()) return number('0', minimumPlaces);
  for (let places = minimumPlaces; places <= maximumPlaces; places++) if (!n.toDecimalPlaces(places).isZero()) return number(n.toFixed(places), places);
  return `< ${number(new D(10).pow(-maximumPlaces).toFixed(maximumPlaces), maximumPlaces)}`;
}
export function usdAmount(value: string | null | undefined): string {
  if (value == null) return '—';
  const n = decimal(value); const sign = n.lt(0) ? '−' : '';
  return `${sign}$${amount(n.abs().toFixed(), 2, 6)}`;
}
export function usd(value: string | null | undefined): string { return value == null ? '—' : `${decimal(value).lt(0) ? '−' : ''}$${number(decimal(value).abs().toFixed())}`; }
export function percent(value: string | null | undefined, places = 1): string { return value == null ? '—' : `${decimal(value).mul(100).toFixed(places)}%`; }
export function barWidth(value: string | null): string { return value === null ? '0%' : D.max(0,D.min(1,decimal(value))).mul(100).toFixed(3) + '%'; }
export function short(value: string): string { return `${value.slice(0,4)}…${value.slice(-4)}`; }
export function date(value: string): string { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)); }
export function time(value: string): string { return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value)) + ' UTC'; }
