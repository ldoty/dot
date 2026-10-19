// House automations: "every weekday at 6:00, turn on the kitchen lights", "when Luke leaves home, text
// him". Shared by the relay
// (relay.mjs runs them at home, so they work with the internet down) and the Lambda (api/automation.mjs
// is a symlink here), so both sides check the same shape and agree on what one says.
//
// An automation:
//   { name, when, repeat, actions, notify, enabled }
//   when     { at: 'HH:MM' }  or  { sun: 'sunrise' | 'sunset', offset: minutes, -180…180 }
//            in the house's own time zone (Home Assistant's), so 6:00 stays 6:00 across DST;
//            or { changes: entity_id, to: state }: when that device (or person) changes to that state,
//            e.g. person.luke_doty to not_home. Never from unavailable or unknown, so a restart of Home
//            Assistant isn't "leaving home"
//   repeat   { rule, start }: which days it runs, as the same calendar rule (RRULE subset) Lists' repeating
//            items and Dot's scheduled asks use (repeat.mjs, shared): FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,
//            FREQ=MONTHLY;BYDAY=1SA, …, UNTIL to end it (no COUNT: the relay doesn't count runs). start is the
//            first local date it may run, and anchors INTERVAL ("every other Monday")
//   actions  0–MAX_ACTIONS commands, each { entity_id, action, data } as POST /commands takes them
//   notify   { message } or null: text the automation's owner (and only them) this, from AWS
//            (api/notify.mjs); no links, ever (the texting campaign is registered without them)
// It must do something: an action or a notify.
// Who may make one and whether it's allowed to run is decided in AWS (api/automations.mjs); the relay
// runs only what AWS last sent it, and checks every action against its own ceiling again when it runs.
import { ID, KEY, parseData } from './protocol.mjs';
import { describe as describeRule, nextAfter, occursOn, parseRule, zonedToIso, YMD } from './repeat.mjs';

export const MAX_ACTIONS = 20;
export const MAX_NAME = 60;
// An automation runs at its time or, if the relay or Home Assistant was down then, within this
// many minutes after; never later, so a 6 AM light doesn't come on at noon after a power cut
export const LATE_MIN = 5;
export const AUTO_ID = /^[a-z0-9]{8,24}$/;
export const MAX_MESSAGE = 160;
const STATE = /^[a-z_]{1,20}$/;
// Anything that reads as a web address: texts never carry links
const LINKISH = /https?:|www\.|\b[\w-]+\.(com|co|net|org|io|app|ly|me|us|info|biz)\b/i;

/** An automation from a request or a message, checked and copied field by field; throws with a reason */
export function parseAutomation(a) {
  const bad = (why) => { throw new Error(why); };
  if (!a || typeof a !== 'object') bad('automation');
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name || name.length > MAX_NAME) bad('name');
  let when;
  const w = a.when;
  if (w && typeof w.at === 'string' && w.sun === undefined && w.changes === undefined) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(w.at);
    if (!m) bad('when.at: HH:MM, 24-hour');
    when = { at: w.at };
  } else if (w && (w.sun === 'sunrise' || w.sun === 'sunset') && w.at === undefined && w.changes === undefined) {
    const offset = w.offset ?? 0;
    if (!Number.isInteger(offset) || Math.abs(offset) > 180) bad('when.offset: whole minutes, -180 to 180');
    when = { sun: w.sun, offset };
  } else if (w && typeof w.changes === 'string' && w.at === undefined && w.sun === undefined) {
    if (!ID.test(w.changes) || !STATE.test(w.to ?? '')) bad('when: { changes: entity id, to: state }');
    when = { changes: w.changes, to: w.to };
  } else bad('when: { at }, { sun, offset } or { changes, to }');
  // `days` was how this said it before repeat; refused, so an old caller never silently gets every day
  if (a.days !== undefined) bad('days: use repeat { rule, start }');
  const rp = a.repeat;
  if (!rp || typeof rp !== 'object' || typeof rp.rule !== 'string') bad('repeat: { rule, start }');
  const rule = rp.rule.replace(/^RRULE:/i, '').toUpperCase();
  try {
    if (parseRule(rule).count !== null) bad('repeat: end it with UNTIL, not COUNT');
  } catch (e) {
    bad(e.message);
  }
  if (!YMD.test(rp.start ?? '') || Number.isNaN(Date.parse(rp.start))) bad('repeat.start: YYYY-MM-DD');
  const list = a.actions ?? [];
  if (!Array.isArray(list) || list.length > MAX_ACTIONS) bad(`actions: up to ${MAX_ACTIONS}`);
  const actions = list.map((x, i) => {
    if (!x || !ID.test(x.entity_id ?? '') || !KEY.test(x.action ?? '')) bad(`actions[${i}]`);
    try {
      return { entity_id: x.entity_id, action: x.action, data: parseData(x.data) };
    } catch (e) {
      return bad(`actions[${i}].${e.message}`);
    }
  });
  let notify = null;
  if (a.notify !== undefined && a.notify !== null) {
    const message = typeof a.notify?.message === 'string' ? a.notify.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE) bad(`notify.message: up to ${MAX_MESSAGE} characters`);
    if (LINKISH.test(message)) bad('notify.message: no links');
    notify = { message };
  }
  if (!actions.length && !notify) bad('actions: it must do something (an action, or notify)');
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') bad('enabled');
  return { name, when, repeat: { rule, start: rp.start }, actions, notify, enabled: a.enabled ?? true };
}

/** The same automation, as stable text: two are the same when this is */
export const canonical = (a) => JSON.stringify([a.name, a.when, [a.repeat.rule, a.repeat.start], a.actions.map((x) => [x.entity_id, x.action, Object.entries(x.data).sort()]), a.notify ?? null, a.enabled]);

// ---- in words ----

function clock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// A person's states read as coming and going; anything else as what it changes to
const CHANGE = { not_home: 'leaves home', home: 'comes home', on: 'turns on', off: 'turns off' };

/** "Every weekday at 6:00 AM", "When Luke Doty leaves home, every weekday": the days in the repeat rule's own words */
export function describeWhen({ when, repeat }, nameOf = (id) => id) {
  const days = describeRule(repeat.rule);
  if (when.changes) {
    const only = repeat.rule === 'FREQ=DAILY' ? '' : `, ${days}`;
    return `When ${nameOf(when.changes)} ${CHANGE[when.to] ?? `changes to ${when.to.replace(/_/g, ' ')}`}${only}`;
  }
  const which = `${days[0].toUpperCase()}${days.slice(1)}`;
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
  if (a.notify) parts.push(`text “${a.notify.message}”`);
  return `${describeWhen(a, nameOf)}: ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
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
  if (a.when.changes) return null; // runs on a change, not a clock
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
  if (!occursOn(a.repeat, local.date)) return null;
  const minute = minuteToday(a, local.date, timeZone, sun);
  if (minute === null || local.minutes < minute || local.minutes >= minute + LATE_MIN) return null;
  return `${local.date}@${minute}`;
}

/**
 * Whether a change of `entityId` from one state to another sets the automation off: the key of this
 * run ('YYYY-MM-DD@minute'), or null. From unavailable or unknown never counts.
 */
export function changeKey(a, { entityId, from, to, now, timeZone }) {
  if (!a.enabled || a.when.changes !== entityId || to !== a.when.to || from === to) return null;
  if (!from || from === 'unavailable' || from === 'unknown') return null;
  const local = localParts(now, timeZone);
  if (!occursOn(a.repeat, local.date)) return null;
  return `${local.date}@${local.minutes}`;
}

const dayBefore = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Whether it has any day left to run on, from local date `today` (its UNTIL may have passed) */
export const hasDaysLeft = (a, today) => nextAfter({ ...a.repeat, n: 0 }, dayBefore(today)) !== null;

/**
 * When an automation at a clock time runs next (ISO), or null: paused, set off by a change or the sun
 * (the sun's times are only known at home), or no days left
 */
export function nextTime(a, now, timeZone) {
  if (!a.enabled || !a.when.at) return null;
  const local = localParts(now, timeZone);
  const [h, m] = a.when.at.split(':').map(Number);
  const day = occursOn(a.repeat, local.date) && h * 60 + m > local.minutes ? local.date : nextAfter({ ...a.repeat, n: 0 }, local.date);
  return day && zonedToIso(day, a.when.at, timeZone);
}

// ---- messages ----
//   AWS -> relay  { type: 'automations', at, items: [{ id, ...automation }] }   the whole set that may
//                 run now (AWS has dropped any whose owner lost access); replaces the relay's copy
//                 unless it's older than the one it has
//   relay -> AWS  { type: 'ran', id, key, at, results: [{ entity_id, action, ok, error? }], notify? }
//                 notify: true when it should text its owner (AWS decides whether it may, and what)

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
  if (Number.isNaN(Date.parse(m.at ?? '')) || !Array.isArray(m.results) || m.results.length > MAX_ACTIONS) bad();
  if (m.notify !== undefined && typeof m.notify !== 'boolean') bad();
  if (!m.results.length && !m.notify) bad();
  const results = m.results.map((r) => {
    if (!r || !ID.test(r.entity_id ?? '') || !KEY.test(r.action ?? '') || typeof r.ok !== 'boolean') bad();
    return { entity_id: r.entity_id, action: r.action, ok: r.ok, ...(r.ok ? {} : { error: String(r.error ?? 'failed').slice(0, 200) }) };
  });
  return { id: m.id, key: m.key, at: new Date(m.at).toISOString(), results, notify: m.notify === true };
}
