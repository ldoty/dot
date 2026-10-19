// Lists' rules, as pure functions: who may do what to a list, and what a list, an item and a
// reminder look like. api.mjs stores them; sweep.mjs sends the reminders.
//
// Access is per list. The person who makes a list owns it; nobody else sees it until the owner
// shares it with a person (`sub:<cognito sub>`) or a family group (`group:<id>`, dot-y.co/family) at
// `read` or `edit`. The highest match wins. There's no admin override: lists can be personal, so
// even family_lists:admin sees only what's shared with them.
//   none < read (see it) < edit (add, change, tick off items; rename; change the layout)
//        < owner (also share it, and delete it)
//
// A layout is only a view of the same items, so switching never loses anything:
//   checklist  ordered, tick things off
//   matrix     Eisenhower: urgent × important, from each item's two flags
//   board      columns (the list's `columns`), from each item's `column`

import { advance, occurrenceOf, parseRepeat, rollAt } from './repeat.mjs';

export const LEVELS = ['none', 'read', 'edit', 'owner'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
export const atLeast = (level, min) => rank(level) >= rank(min);

export const LAYOUTS = ['checklist', 'matrix', 'board'];
export const DEFAULT_COLUMNS = ['To do', 'Doing', 'Done'];
export const CHANNELS = ['sms', 'email'];
export const ID = /^[a-z0-9]{6,24}$/;
const SUB = /^[0-9a-f-]{36}$/;
const WHO = /^(sub:[0-9a-f-]{36}|group:g[a-z0-9]{8,20})$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** This person's level on a list. person: { sub, groupIds: Set of family group ids they're in } */
export function levelOf(person, list) {
  if (list.owner === person.sub) return 'owner';
  let best = 0;
  for (const s of list.share ?? []) {
    const hit = s.who === `sub:${person.sub}` || (s.who.startsWith('group:') && person.groupIds.has(s.who.slice(6)));
    if (hit) best = Math.max(best, rank(s.level));
  }
  return LEVELS[best];
}

const text = (v, max, what, required = true) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${what} is required`);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max) throw new Error(`${what}: text up to ${max} characters`);
  return v.trim() || (required ? (() => { throw new Error(`${what} is required`); })() : null);
};

/** A list's own fields from input; throws with a reason */
export function parseList(b) {
  const name = text(b.name, 80, 'name');
  const layout = b.layout ?? 'checklist';
  if (!LAYOUTS.includes(layout)) throw new Error(`layout: one of ${LAYOUTS.join(', ')}`);
  let columns = b.columns ?? DEFAULT_COLUMNS;
  if (!Array.isArray(columns) || !columns.length || columns.length > 8) throw new Error('columns: 1 to 8');
  columns = columns.map((c) => text(c, 30, 'column'));
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new Error('columns must differ');
  return { name, layout, columns };
}

/** Who a list is shared with; throws with a reason */
export function parseShare(share) {
  if (!Array.isArray(share) || share.length > 20) throw new Error('share: up to 20');
  const seen = new Set();
  return share.map((s) => {
    if (!s || !WHO.test(s.who ?? '') || !['read', 'edit'].includes(s.level)) throw new Error('share: { who: sub:… or group:…, level: read or edit }');
    if (seen.has(s.who)) throw new Error('share: each person or group once');
    seen.add(s.who);
    return { who: s.who, level: s.level };
  });
}

/**
 * An item's fields from input; throws with a reason. remind: { at: ISO time, channel?: sms | email }
 * or null; who it goes to is set by the API (whoever set it), and sentAt only by the sweep.
 * repeat: { rule, mode, tz } or null (repeat.mjs); it needs a due date or a reminder to repeat from,
 * and schedule mode needs a reminder.
 */
export function parseItem(b) {
  const out = {
    text: text(b.text, 300, 'text'),
    done: b.done === true,
    notes: text(b.notes, 2000, 'notes', false),
    due: b.due ?? null,
    urgent: b.urgent === true,
    important: b.important === true,
    column: text(b.column, 30, 'column', false),
    order: b.order ?? 0,
    assignee: b.assignee ?? null,
    remind: null,
    repeat: null,
  };
  if (out.due !== null && !DAY.test(out.due)) throw new Error('due: YYYY-MM-DD');
  if (typeof out.order !== 'number' || !Number.isFinite(out.order)) throw new Error('order: a number');
  if (out.assignee !== null && !SUB.test(out.assignee)) throw new Error('assignee: a person');
  if (b.remind) {
    const at = new Date(b.remind.at);
    if (typeof b.remind.at !== 'string' || Number.isNaN(at.getTime())) throw new Error('remind.at: a date and time');
    const channel = b.remind.channel ?? null;
    if (channel !== null && !CHANNELS.includes(channel)) throw new Error(`remind.channel: ${CHANNELS.join(' or ')}`);
    out.remind = { at: at.toISOString(), channel };
  }
  if (b.repeat) {
    out.repeat = parseRepeat(b.repeat);
    if (!out.due && !out.remind) throw new Error('repeat needs a due date or a reminder to repeat from');
    if (out.repeat.mode === 'schedule' && !out.remind) throw new Error('repeating on schedule needs a reminder');
  }
  return out;
}

/**
 * The sweep's index row for an item's reminder, or null when nothing should be sent: its reminder
 * until sent; then, for a schedule-mode repeat, the next occurrence's (when it rolls on, unticked)
 */
export function reminderKey(listId, itemId, item) {
  if (!item.remind || item.done) return null;
  const at = item.remind.sentAt ? rollAt(item) : item.remind.at;
  return at ? { pk: `REMIND#${at.slice(0, 10)}`, sk: `${at}#${listId}#${itemId}` } : null;
}

/**
 * The stored item after a write: a repeat keeps its start and count while its rule is unchanged
 * (else it starts from this occurrence), and ticking off a repeating item moves it to its next one
 */
export function settle(fields, old, at) {
  let item = fields;
  if (item.repeat) {
    const same = old?.repeat && old.repeat.rule === item.repeat.rule && old.repeat.tz === item.repeat.tz;
    item = { ...item, repeat: same ? { ...old.repeat, mode: item.repeat.mode } : { ...item.repeat, start: occurrenceOf(item, item.repeat.tz), n: 0 } };
  }
  if (item.done && !old?.done && item.repeat && !item.repeat.ended) return advance(item, { at });
  return item;
}

/** Which matrix quadrant an item is in */
export const quadrant = (i) => (i.urgent ? (i.important ? 'do' : 'delegate') : (i.important ? 'schedule' : 'drop'));
