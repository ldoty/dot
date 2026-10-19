// Repeating items, as pure functions. A repeat is a small part of the calendar standard's rule
// format (RFC 5545 RRULE), checked on the way in, plus how the next one comes:
//   { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', mode: 'when_done' | 'schedule', tz, start, n }
//     tz     the person's time zone: a 9:00 reminder stays 9:00 there across daylight saving
//     start  the first occurrence's local date (YYYY-MM-DD): fixes which weeks/months are "on"
//     n      how many occurrences have gone by (for COUNT)
// Rules: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL=1..99, and
//   WEEKLY   BYDAY=MO,TU,…           which days (default: the start's weekday)
//   MONTHLY  BYMONTHDAY=1..31 or -1  a date; past the month's end means its last day (the 31st in
//                                    April is the 30th, as people expect for bills)
//            or BYDAY=2TU / -1FR     the 2nd Tuesday, the last Friday (default: the start's date)
//   YEARLY   the start's month and date
//   UNTIL=YYYYMMDD or COUNT=1..999 to end it.
// Ticking an item off always moves it to its next occurrence. If it isn't ticked off: in when_done
// mode it waits, overdue; in schedule mode it rolls on to the next occurrence and reminds again
// (the sweep does that; schedule mode needs a reminder). When the series ends, ticking it off is done.

export const MODES = ['when_done', 'schedule'];
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ---- dates as plain local calendar days (UTC arithmetic on Y-M-D, no time zones) ----
const toDay = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;
const fromDay = (d) => new Date(d * 86_400_000).toISOString().slice(0, 10);
const weekday = (d) => (new Date(d * 86_400_000).getUTCDay() + 6) % 7; // Monday = 0
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m: 0-11

/** Parses and checks a rule; throws with a reason */
export function parseRule(s) {
  if (typeof s !== 'string' || s.length > 120) throw new Error('repeat: a rule like FREQ=WEEKLY;BYDAY=TU');
  const parts = Object.fromEntries(s.replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => {
    const [k, v] = p.split('=');
    return [String(k).toUpperCase(), String(v ?? '').toUpperCase()];
  }));
  const allowed = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'COUNT'];
  const extra = Object.keys(parts).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`repeat: ${extra.join(', ')} isn’t supported`);
  const r = { freq: parts.FREQ, interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1, byday: null, bymonthday: null, until: null, count: null };
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.freq)) throw new Error('repeat: FREQ is DAILY, WEEKLY, MONTHLY or YEARLY');
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 99) throw new Error('repeat: INTERVAL 1 to 99');
  if (parts.BYDAY) {
    r.byday = parts.BYDAY.split(',').map((x) => {
      const m = /^(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x);
      if (!m) throw new Error(`repeat: BYDAY ${x}`);
      return { n: m[1] ? Number(m[1]) : null, day: DAYS.indexOf(m[2]) };
    });
    if (r.freq === 'WEEKLY' && r.byday.some((b) => b.n !== null)) throw new Error('repeat: weekly BYDAY takes plain days (TU, not 2TU)');
    if (r.freq === 'MONTHLY' && (r.byday.length !== 1 || r.byday[0].n === null)) throw new Error('repeat: monthly BYDAY is one position, like 2TU or -1FR');
    if (!['WEEKLY', 'MONTHLY'].includes(r.freq)) throw new Error('repeat: BYDAY only with WEEKLY or MONTHLY');
  }
  if (parts.BYMONTHDAY) {
    r.bymonthday = Number(parts.BYMONTHDAY);
    if (r.freq !== 'MONTHLY' || !(Number.isInteger(r.bymonthday) && ((r.bymonthday >= 1 && r.bymonthday <= 31) || r.bymonthday === -1))) {
      throw new Error('repeat: BYMONTHDAY 1 to 31 or -1, only with MONTHLY');
    }
    if (r.byday) throw new Error('repeat: monthly is BYMONTHDAY or BYDAY, not both');
  }
  if (parts.UNTIL && parts.COUNT) throw new Error('repeat: UNTIL or COUNT, not both');
  if (parts.UNTIL) {
    if (!/^\d{8}$/.test(parts.UNTIL)) throw new Error('repeat: UNTIL=YYYYMMDD');
    r.until = `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  }
  if (parts.COUNT) {
    r.count = Number(parts.COUNT);
    if (!Number.isInteger(r.count) || r.count < 1 || r.count > 999) throw new Error('repeat: COUNT 1 to 999');
  }
  return r;
}

/** Is local day `d` (a day number) an occurrence of rule `r` starting on day `s`? */
function occurs(r, s, d) {
  const sd = new Date(s * 86_400_000), dd = new Date(d * 86_400_000);
  if (r.freq === 'DAILY') return (d - s) % r.interval === 0;
  if (r.freq === 'WEEKLY') {
    const weeks = Math.floor((d - weekday(d) - (s - weekday(s))) / 7);
    const on = r.byday ? r.byday.map((b) => b.day) : [weekday(s)];
    return weeks % r.interval === 0 && on.includes(weekday(d));
  }
  const months = (dd.getUTCFullYear() - sd.getUTCFullYear()) * 12 + dd.getUTCMonth() - sd.getUTCMonth();
  const y = dd.getUTCFullYear(), m = dd.getUTCMonth(), last = daysIn(y, m), date = dd.getUTCDate();
  if (r.freq === 'MONTHLY') {
    if (months % r.interval !== 0) return false;
    if (r.byday) {
      const { n, day } = r.byday[0];
      if (weekday(d) !== day) return false;
      return n === -1 ? date + 7 > last : Math.ceil(date / 7) === n;
    }
    const want = r.bymonthday === -1 ? last : Math.min(r.bymonthday ?? sd.getUTCDate(), last);
    return date === want;
  }
  // YEARLY: the start's month and date (Feb 29 falls on Feb 28 in other years)
  return months % (12 * r.interval) === 0 && date === Math.min(sd.getUTCDate(), last);
}

/** The first occurrence after local date `after`, or null when the series has ended */
export function nextAfter(repeat, after) {
  const r = parseRule(repeat.rule);
  if (r.count !== null && (repeat.n ?? 0) + 1 >= r.count) return null;
  const s = toDay(repeat.start);
  for (let d = Math.max(toDay(after) + 1, s); d <= toDay(after) + 366 * 12; d++) {
    if (!occurs(r, s, d)) continue;
    if (r.until && fromDay(d) > r.until) return null;
    return fromDay(d);
  }
  return null;
}

// ---- time zones ----

/** "2026-10-20" + "09:00" in tz -> ISO (UTC), across daylight saving */
export function zonedToIso(ymd, hm, tz) {
  const wall = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), +hm.slice(0, 2), +hm.slice(3, 5));
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t).toISOString();
}

/** An ISO time as [local date, local "HH:MM"] in tz */
export function localParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return [`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`];
}

export const validZone = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length < 60; } catch { return false; }
};

/** The local date of an item's current occurrence: its due date, else its reminder's date */
export const occurrenceOf = (item, tz) => item.due ?? (item.remind ? localParts(item.remind.at, tz)[0] : null);

/**
 * The item moved on to its next occurrence (due date and reminder, same local time), not done and
 * not yet reminded; or, when the series has ended, simply done. `at`: now, for lastDoneAt.
 */
export function advance(item, { at, done = true }) {
  const rp = item.repeat;
  const current = occurrenceOf(item, rp.tz);
  const next = current && nextAfter(rp, current);
  if (!next) return { ...item, done: true, doneAt: at, repeat: { ...rp, ended: true } };
  const out = { ...item, done: false, doneAt: null, repeat: { ...rp, n: (rp.n ?? 0) + 1, ...(done ? { lastDoneAt: at } : {}) } };
  if (item.due) out.due = next;
  if (item.remind) out.remind = { ...item.remind, at: zonedToIso(next, localParts(item.remind.at, rp.tz)[1], rp.tz), sentAt: null };
  return out;
}

/** When a schedule-mode item that's been reminded rolls on, unticked: its next occurrence's reminder time */
export function rollAt(item) {
  if (!item.repeat || item.repeat.mode !== 'schedule' || !item.remind?.sentAt) return null;
  const next = nextAfter(item.repeat, occurrenceOf(item, item.repeat.tz));
  return next && zonedToIso(next, localParts(item.remind.at, item.repeat.tz)[1], item.repeat.tz);
}

/** "every other Tuesday", "every month on the last Friday", "every 3 months", … plus how it ends */
export function describe(rule) {
  const r = parseRule(rule);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const every = r.interval === 1 ? `every ${unit}` : r.interval === 2 ? `every other ${unit}` : `every ${r.interval} ${unit}s`;
  const ord = (n) => (n === -1 ? 'last' : ['', '1st', '2nd', '3rd', '4th'][n]);
  const dateOrd = (n) => (n === -1 ? 'the last day' : `the ${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10] ?? 'th'}`);
  let s = every;
  if (r.freq === 'WEEKLY' && r.byday) {
    const days = r.byday.map((b) => b.day).sort();
    const list = days.join() === '0,1,2,3,4' ? 'weekdays' : days.map((d) => DAY_NAMES[d]).join(', ');
    s = r.interval === 1 ? (days.join() === '0,1,2,3,4' ? 'every weekday' : `every ${list}`)
      : r.interval === 2 && days.length === 1 ? `every other ${list}` : `${every} on ${list}`;
  }
  if (r.freq === 'MONTHLY' && r.byday) s += ` on the ${ord(r.byday[0].n)} ${DAY_NAMES[r.byday[0].day]}`;
  if (r.freq === 'MONTHLY' && r.bymonthday) s += ` on ${dateOrd(r.bymonthday)}`;
  if (r.until) s += `, until ${r.until}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}

/** A repeat from input (rule, mode, tz); start and n are set by the API. Throws with a reason */
export function parseRepeat(b) {
  if (!b || typeof b !== 'object') throw new Error('repeat: { rule, mode, tz }');
  parseRule(b.rule);
  const mode = b.mode ?? 'when_done';
  if (!MODES.includes(mode)) throw new Error(`repeat.mode: ${MODES.join(' or ')}`);
  if (!validZone(b.tz)) throw new Error('repeat.tz: a time zone like America/New_York');
  return { rule: b.rule.replace(/^RRULE:/i, '').toUpperCase(), mode, tz: b.tz };
}

export { YMD };
