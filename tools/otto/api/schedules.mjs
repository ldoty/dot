// Otto's schedules: a fixed prompt Otto runs on its own ("the daily brief, every day at 6:00"). At its
// time the sweep (sweep.mjs) queues the prompt exactly as it was saved, as a command from `schedule`;
// nothing at run time can change what it says. Saving one is a standing order, so from Dot or Claude
// Code (a delegated token) every change needs the person's own OK first (api.mjs), as for the house's
// automations and Dot's scheduled asks.
//
// Days are the RRULE subset Lists and Dot use (repeat.mjs, symlinked from tools/lists), on calendar days
// in the family's time zone, so 6:00 stays 6:00 across daylight saving. No COUNT: UNTIL ends one.
//
// Rows: SCHED / <id>   { name, prompt, time 'HH:MM', repeat { rule, start, tz }, enabled, nextAt (ISO; null
//                        while paused or once ended), lastRun { at, outcome, command }?, owner, rev,
//                        changedBy, changedAt }
import { describe as describeRule, localParts, nextAfter, parseRule, validZone, zonedToIso, YMD } from './repeat.mjs';

export const SCHED_ID = /^s[a-z0-9]{10}$/;
export const MAX_SCHEDULES = 20;
export const LIMITS = { name: 60, prompt: 4000 };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const dayBefore = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - 86_400_000).toISOString().slice(0, 10);

/** The first time this schedule runs after `afterIso`, or null when its series has ended */
export function nextRun({ time, repeat }, afterIso) {
  const [today] = localParts(afterIso, repeat.tz);
  let day = nextAfter(repeat, dayBefore(repeat.start > today ? repeat.start : today));
  while (day) {
    const at = zonedToIso(day, time, repeat.tz);
    if (at > afterIso) return at;
    day = nextAfter(repeat, day);
  }
  return null;
}

/**
 * A schedule from input, checked (throws with a reason): { name, prompt, time, repeat { rule, start }, enabled }.
 * repeat may be left out (every day); start is today unless given, or the old start while the rule stays.
 */
export function cleanSchedule(input, { tz, today, row = null }) {
  const name = String(input.name ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  if (!name || name.length > LIMITS.name) throw new Error(`name: up to ${LIMITS.name} characters`);
  if (!prompt || prompt.length > LIMITS.prompt) throw new Error(`prompt: what Otto does each time, up to ${LIMITS.prompt} characters`);
  if (!TIME.test(input.time ?? '')) throw new Error('time: "HH:MM", 24-hour, the family’s local time');
  const given = input.repeat ?? { rule: 'FREQ=DAILY' };
  if (!given || typeof given !== 'object' || typeof given.rule !== 'string') throw new Error('repeat: { rule, start? }');
  const rule = given.rule.replace(/^RRULE:/i, '').toUpperCase();
  parseRule(rule);
  if (/COUNT=/.test(rule)) throw new Error('repeat: use UNTIL to end it, not COUNT');
  if (!validZone(tz)) throw new Error('time zone');
  const start = given.start ?? (row?.repeat?.rule === rule ? row.repeat.start : today);
  if (!YMD.test(start)) throw new Error('repeat.start: YYYY-MM-DD');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled: true or false');
  return { name, prompt, time: input.time, repeat: { rule, start, tz }, enabled: input.enabled ?? true };
}

/** The same schedule, always written the same way: what a confirmation is for */
export const canonical = (s) => JSON.stringify([s.name, s.prompt, s.time, s.repeat.rule, s.repeat.start, s.enabled]);

const clock = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** "Every weekday at 6:00 AM: run “Daily brief”" */
export function says(s) {
  const when = describeRule(s.repeat.rule);
  return `${when[0].toUpperCase()}${when.slice(1)} at ${clock(s.time)}: Otto runs “${s.name}”`;
}

/** The row in the shape every tool's automations share (platform/api/dot-manifest.mjs, role automations) */
export function automationOf(row, sub) {
  const status = !row.enabled ? 'paused' : row.nextAt ? 'on' : 'stopped';
  return {
    id: row.sk, kind: 'otto', name: row.name, says: says(row), status,
    ...(status === 'stopped' ? { why: 'its last day has passed' } : {}),
    mine: row.owner === sub, can_change: true,
    last_run: row.lastRun ? { at: row.lastRun.at, outcome: row.lastRun.outcome } : null,
    next_at: status === 'on' ? row.nextAt : null,
    // Otto's own fields, for the page and for changing it
    prompt: row.prompt, time: row.time, repeat: { rule: row.repeat.rule, start: row.repeat.start }, enabled: row.enabled, rev: row.rev,
  };
}
