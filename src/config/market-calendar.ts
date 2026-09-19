// Scheduled US cash-equity CORE sessions only. Never implies token/DEX availability.
// NYSE + Nasdaq calendars independently checked 2026-09-13. Outside 2026 is unknown.
export const marketCalendar = {
  id: 'us-core-2026-v1', timezone: 'America/New_York', year: 2026,
  checkedAt: '2026-09-13',
  sources: ['https://www.nyse.com/trade/hours-calendars', 'https://www.nasdaqtrader.com/Trader.aspx?id=calendar'],
  holidays: {
    '2026-01-01': 'New Year’s Day', '2026-01-19': 'Martin Luther King Jr. Day',
    '2026-02-16': 'Washington’s Birthday', '2026-04-03': 'Good Friday',
    '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth',
    '2026-07-03': 'Independence Day observed', '2026-09-07': 'Labor Day',
    '2026-11-26': 'Thanksgiving', '2026-12-25': 'Christmas',
  } as Record<string, string>,
  earlyCloses: { '2026-11-27': 780, '2026-12-24': 780 } as Record<string, number>,
  openMinute: 570, closeMinute: 960,
};
