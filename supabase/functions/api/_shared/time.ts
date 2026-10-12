// Time helpers: the business works in UK time (Europe/London, BST/GMT).
const TZ = "Europe/London";

function partsInLondon(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return p;
}

/** Offset of London from UTC in minutes at a given instant (0 in winter, 60 in summer). */
function londonOffsetMinutes(d: Date): number {
  const p = partsInLondon(d);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** Convert a London wall-clock date ("2026-10-16") and time ("10:00") to a UTC Date. */
export function londonToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off = londonOffsetMinutes(guess);
  const first = new Date(guess.getTime() - off * 60000);
  const off2 = londonOffsetMinutes(first);
  return off2 === off ? first : new Date(guess.getTime() - off2 * 60000);
}

/** London calendar date (YYYY-MM-DD) of an instant. */
export function londonDate(d: Date): string {
  const p = partsInLondon(d);
  return `${p.year}-${p.month}-${p.day}`;
}

export function londonWeekday(d: Date): string {
  return partsInLondon(d).weekday; // Mon, Tue ...
}

/** "Fri 16 Oct, 10:00" */
export function formatSlot(d: Date): string {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${date}, ${time}`;
}

/** "Friday 16 October" */
export function formatLongDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(d);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function timeString(t: string): string {
  // Postgres time "09:00:00" -> "09:00"
  return t.slice(0, 5);
}
