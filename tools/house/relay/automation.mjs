// House automations: "every weekday at 6:00, turn on the kitchen lights". Shared by the relay
// (relay.mjs runs them at home, so they work with the internet down) and the Lambda (api/automation.mjs
// is a symlink here), so both sides check the same shape and agree on what one says.
//
// An automation:
//   { name, when, days, actions, enabled }
//   when     { at: 'HH:MM' }  or  { sun: 'sunrise' | 'sunset', offset: minutes, -180…180 }
//            in the house's own time zone (Home Assistant's), so 6:00 stays 6:00 across DST
//   days     which days it runs: some of DAYS
//   actions  1–MAX_ACTIONS commands, each { entity_id, action, data } as POST /commands takes them
// Who may make one and whether it's allowed to run is decided in AWS (api/automations.mjs); the relay
// runs only what AWS last sent it, and checks every action against its own ceiling again when it runs.
import { ID, KEY, parseData } from './protocol.mjs';

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MAX_ACTIONS = 20;
export const MAX_NAME = 60;
// An automation runs at its time or, if the relay or Home Assistant was down then, within this
// many minutes after; never later, so a 6 AM light doesn't come on at noon after a power cut
export const LATE_MIN = 5;
export const AUTO_ID = /^[a-z0-9]{8,24}$/;

/** An automation from a request or a message, checked and copied field by field; throws with a reason */
export function parseAutomation(a) {
  const bad = (why) => { throw new Error(why); };
  if (!a || typeof a !== 'object') bad('automation');
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name || name.length > MAX_NAME) bad('name');
  let when;
  const w = a.when;
  if (w && typeof w.at === 'string' && w.sun === undefined) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(w.at);
    if (!m) bad('when.at: HH:MM, 24-hour');
    when = { at: w.at };
  } else if (w && (w.sun === 'sunrise' || w.sun === 'sunset') && w.at === undefined) {
    const offset = w.offset ?? 0;
    if (!Number.isInteger(offset) || Math.abs(offset) > 180) bad('when.offset: whole minutes, -180 to 180');
    when = { sun: w.sun, offset };
  } else bad('when: { at } or { sun, offset }');
  const days = a.days ?? DAYS;
  if (!Array.isArray(days) || !days.length || days.some((d) => !DAYS.includes(d)) || new Set(days).size !== days.length) bad('days');
  if (!Array.isArray(a.actions) || !a.actions.length || a.actions.length > MAX_ACTIONS) bad(`actions: 1–${MAX_ACTIONS}`);
  const actions = a.actions.map((x, i) => {
    if (!x || !ID.test(x.entity_id ?? '') || !KEY.test(x.action ?? '')) bad(`actions[${i}]`);
    try {
      return { entity_id: x.entity_id, action: x.action, data: parseData(x.data) };
    } catch (e) {
      return bad(`actions[${i}].${e.message}`);
    }
  });
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') bad('enabled');
  return { name, when, days: DAYS.filter((d) => days.includes(d)), actions, enabled: a.enabled ?? true };
}

/** The same automation, as stable text: two are the same when this is */
export const canonical = (a) => JSON.stringify([a.name, a.when, a.days, a.actions.map((x) => [x.entity_id, x.action, Object.entries(x.data).sort()]), a.enabled]);

// ---- in words ----

function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };

export function describeWhen({ when, days }) {
  const set = days.join(',');
  const which = set === DAYS.join(',') ? 'Every day' : set === 'mon,tue,wed,thu,fri' ? 'Every weekday' : set === 'sun,sat' ? 'Every weekend day'
    : `Every ${days.length > 1 ? `${days.slice(0, -1).map((d) => DAY_NAMES[d]).join(', ')} and ${DAY_NAMES[days.at(-1)]}` : DAY_NAMES[days[0]]}`;
  if (when.at) return `${which} at ${clock(when.at)}`;
  const off = when.offset;
  return `${which} ${off ? `${Math.abs(off)} minutes ${off < 0 ? 'before' : 'after'}` : 'at'} ${when.sun}`;
}

function describeAction({ action, data }, name) {
  const verb = action === 'turn_on' ? 'turn on' : action === 'turn_off' ? 'turn off' : action.replace(/_/g, ' ');
  const extra = [data.brightness_pct && `${data.brightness_pct}%`, data.transition && `fading over ${data.transition} s`].filter(Boolean);
  return `${verb} ${name}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

/** "Every weekday at 6:00 AM: turn on Kitchen main (80%) and turn on Kitchen island", names by entity id */
export function describe(a, nameOf = (id) => id) {
  const parts = a.actions.map((x) => describeAction(x, nameOf(x.entity_id)));
  return `${describeWhen(a)}: ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
}

// ---- when it runs (the relay) ----

/** The wall clock in timeZone: { date: 'YYYY-MM-DD', day: 'mon', minutes since midnight } */
export function localParts(t, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: p.weekday.toLowerCase().slice(0, 3), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * Today's minute for the automation, or null if it has none today. sun: Home Assistant's sun.sun
 * attributes ({ next_rising, next_setting }); after today's sunrise, next_rising is tomorrow's, and a
 * day earlier is within a couple of minutes of today's.
 */
export function minuteToday(a, today, timeZone, sun) {
  if (a.when.at) {
    const [h, m] = a.when.at.split(':').map(Number);
    return h * 60 + m;
  }
  const next = sun?.[a.when.sun === 'sunrise' ? 'next_rising' : 'next_setting'];
  if (!next || Number.isNaN(Date.parse(next))) return null;
  let t = Date.parse(next);
  if (localParts(t, timeZone).date !== today) t -= 86_400_000;
  const local = localParts(t, timeZone);
  if (local.date !== today) return null;
  const minute = local.minutes + a.when.offset;
  return minute >= 0 && minute < 1440 ? minute : null;
}

/**
 * Whether the automation is due at `now`: the key of this run ('YYYY-MM-DD@minute'), or null. The
 * caller keeps the last key it ran for each automation, so a run happens once, even across restarts.
 */
export function dueKey(a, now, timeZone, sun) {
  if (!a.enabled) return null;
  const local = localParts(now, timeZone);
  if (!a.days.includes(local.day)) return null;
  const minute = minuteToday(a, local.date, timeZone, sun);
  if (minute === null || local.minutes < minute || local.minutes >= minute + LATE_MIN) return null;
  return `${local.date}@${minute}`;
}

// ---- messages ----
//   AWS -> relay  { type: 'automations', at, items: [{ id, ...automation }] }   the whole set that may
//                 run now (AWS has dropped any whose owner lost access); replaces the relay's copy
//                 unless it's older than the one it has
//   relay -> AWS  { type: 'ran', id, key, at, results: [{ entity_id, action, ok, error? }] }

export const MAX_AUTOMATIONS = 40; // 40 x 20 actions stays well under API Gateway's 128 KB message

/** The set AWS sent, checked; throws with a reason */
export function parseAutomations(m) {
  if (!m || m.type !== 'automations' || Number.isNaN(Date.parse(m.at ?? ''))) throw new Error('automations: type/at');
  if (!Array.isArray(m.items) || m.items.length > MAX_AUTOMATIONS) throw new Error('automations: items');
  return {
    at: m.at,
    items: m.items.map((x) => {
      if (!AUTO_ID.test(x?.id ?? '')) throw new Error('automations: id');
      return { id: x.id, ...parseAutomation(x) };
    }),
  };
}

/** How a run went, as AWS receives it; throws with a reason */
export function parseRan(m) {
  const bad = () => { throw new Error('bad ran'); };
  if (!m || m.type !== 'ran' || !AUTO_ID.test(m.id ?? '') || !/^\d{4}-\d{2}-\d{2}@\d{1,4}$/.test(m.key ?? '')) bad();
  if (Number.isNaN(Date.parse(m.at ?? '')) || !Array.isArray(m.results) || !m.results.length || m.results.length > MAX_ACTIONS) bad();
  const results = m.results.map((r) => {
    if (!r || !ID.test(r.entity_id ?? '') || !KEY.test(r.action ?? '') || typeof r.ok !== 'boolean') bad();
    return { entity_id: r.entity_id, action: r.action, ok: r.ok, ...(r.ok ? {} : { error: String(r.error ?? 'failed').slice(0, 200) }) };
  });
  return { id: m.id, key: m.key, at: new Date(m.at).toISOString(), results };
}
