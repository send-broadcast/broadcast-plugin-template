// The cron expressions of manifest.json hooks.schedules, read as Broadcast reads them (Fugit::Cron,
// checked by spec/plugin-api-1-vectors.json cron). Five fields (minute hour day month weekday) and an
// optional time zone, or @hourly, @daily, @midnight, @weekly, @monthly, @yearly, @annually. A field
// takes *, numbers, names (jan, mon), ranges, steps and lists; the day takes L and -n (from the end
// of the month), the weekday 0-7 and mon#2 or mon#-1. When both the day and the weekday are set, a
// time matches either (as in cron). Without a zone a time is UTC, as on a Broadcast server.

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// A schedule on 29 February runs once in up to 8 years (2096, then 2104)
const SEARCH_DAYS = 366 * 9;

export type Cron = {
  minutes: number[]; hours: number[]; months: Set<number>; zone: string | null;
  days: Set<number>; fromEnd: Set<number>; anyDay: boolean;
  weekdays: Set<number>; nth: Map<number, Set<number>>; anyWeekday: boolean;
};

function values(field: string, min: number, max: number, names: string[] = [], base = min): number[] | null {
  const out = new Set<number>();
  const number = (text: string): number | null => {
    const index = names.indexOf(text.toLowerCase());
    if (index >= 0) return index + base;
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return n >= min && n <= max ? n : null;
  };
  for (const part of field.split(",")) {
    const match = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) return null;
    let from: number | null, to: number | null;
    if (match[1] === "*") [from, to] = [min, max];
    else if (match[1].includes("-")) {
      const [a, b, ...rest] = match[1].split("-");
      if (rest.length) return null;
      [from, to] = [number(a), number(b)];
    } else {
      from = number(match[1]);
      to = match[2] === undefined ? from : max;
    }
    if (from === null || to === null || from > to) return null;
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// null when Broadcast would refuse the expression
export function parseCron(text: string): Cron | null {
  let parts = text.trim().split(/\s+/);
  if (parts[0]?.startsWith("@")) {
    const alias = ALIASES[parts[0].toLowerCase()];
    if (!alias) return null;
    parts = [...alias.split(" "), ...parts.slice(1)];
  }
  if (parts.length < 5 || parts.length > 6) return null;
  const zone = parts[5] ?? null;
  if (zone !== null) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      return null;
    }
  }
  const minutes = values(parts[0], 0, 59);
  const hours = values(parts[1], 0, 23);
  const monthList = values(parts[3], 1, 12, MONTHS, 1);
  if (!minutes || !hours || !monthList) return null;

  const days = new Set<number>(), fromEnd = new Set<number>();
  const anyDay = parts[2] === "*";
  if (!anyDay) {
    for (const part of parts[2].split(",")) {
      if (part.toUpperCase() === "L") fromEnd.add(1);
      else if (/^-\d+$/.test(part) && Number(part) <= -1 && Number(part) >= -30) fromEnd.add(-Number(part));
      else {
        const list = values(part, 1, 31);
        if (!list) return null;
        list.forEach((d) => days.add(d));
      }
    }
  }

  const weekdays = new Set<number>(), nth = new Map<number, Set<number>>();
  const anyWeekday = parts[4] === "*";
  if (!anyWeekday) {
    for (const part of parts[4].split(",")) {
      const hash = part.match(/^([a-z]+|\d)#(-?[1-5])$/i);
      if (hash) {
        const day = values(hash[1], 0, 7, DAYS)?.[0];
        if (day === undefined) return null;
        const key = day % 7;
        if (!nth.has(key)) nth.set(key, new Set());
        nth.get(key)!.add(Number(hash[2]));
        continue;
      }
      const list = values(part, 0, 7, DAYS);
      if (!list) return null;
      list.forEach((d) => weekdays.add(d % 7));
    }
  }

  const months = new Set(monthList);
  // A day that no month in the list has (30 February) is refused
  if (anyWeekday && days.size && fromEnd.size === 0 && !monthList.some((m) => Math.min(...days) <= MAX_DAYS[m - 1])) return null;
  return { minutes, hours, months, zone, days, fromEnd, anyDay, weekdays, nth, anyWeekday };
}

// --- time zones: wall clock fields of an instant, and the instant of wall clock fields ---

const formats = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, zone: string | null): { y: number; m: number; d: number; h: number; mi: number } {
  if (zone === null) {
    const t = new Date(ms);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
  }
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formats.set(zone, format);
  }
  const part = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: Number(part.year), m: Number(part.month), d: Number(part.day), h: Number(part.hour), mi: Number(part.minute) };
}

function instant(y: number, m: number, d: number, h: number, mi: number, zone: string | null): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  if (zone === null) return guess;
  const offset = (ms: number) => {
    const w = wall(ms, zone);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = offset(guess);
  const second = offset(guess - first);
  return guess - second;
}

function dayMatches(cron: Cron, y: number, m: number, d: number): boolean {
  if (!cron.months.has(m)) return false;
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const byDay = cron.days.has(d) || cron.fromEnd.has(length - d + 1);
  const occurrences = cron.nth.get(weekday);
  const byWeekday = cron.weekdays.has(weekday) ||
    (occurrences !== undefined && (occurrences.has(Math.ceil(d / 7)) || occurrences.has(-Math.ceil((length - d + 1) / 7))));
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

function search(cron: Cron, now: number, direction: 1 | -1): number | null {
  const start = wall(now, cron.zone);
  const hours = direction === 1 ? cron.hours : [...cron.hours].reverse();
  const minutes = direction === 1 ? cron.minutes : [...cron.minutes].reverse();
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + direction * i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(cron, y, m, d)) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const at = instant(y, m, d, h, mi, cron.zone);
        if (direction === 1 ? at > now : at < now) return at;
      }
    }
  }
  return null;
}

// The last due time before now (Fugit::Cron#previous_time)
export function previousTime(cron: Cron, now: number): number | null {
  return search(cron, now, -1);
}

// The first due time after now (Fugit::Cron#next_time)
export function nextTime(cron: Cron, now: number): number | null {
  return search(cron, now, 1);
}
