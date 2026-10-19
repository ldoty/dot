// Scheduled asks: "text me a budget overview every Sunday at 1". At its time Dot runs the ask as the
// person who set it up (scheduled.mjs), with their own access but read-only, and texts or emails
// them the answer. Each person's are their own: only they see, make or delete them.
//
// Rows (lukes-assistant):
//   SCHED#<sub> / <id>             { title, ask, time 'HH:MM', repeat { rule, tz, start, n }, by 'sms' | 'email',
//                                    enabled (false: paused; missing on older rows means true),
//                                    nextAt (ISO; null while paused or once it's ended), lastRun { at, ok, conversationId?, error? },
//                                    createdAt, createdVia, rev }
//   SCHEDDUE / <nextAt>#<sub>#<id>  the runner's index: what's due next. Rewritten whenever nextAt changes; none while paused
// The repeat rule is Lists' (repeat.mjs, RRULE subset: daily at most), on the person's own calendar
// days in their time zone, so 1:00 PM stays 1:00 PM across daylight saving.
//
// Making one is a standing permission (Dot reading as them, later, with no one asking), so it needs
// their own reply first, enforced in code (confirm.mjs) the same way as House's confirmations. So does
// every other change Dot makes to one (pause, resume, delete), as for the house's automations: the
// rule is the same for every automation. On Dot's page the person makes the change themselves.
//
// Each is also an automation in the shape every tool's share (askAutomation; platform/api/dot-manifest.mjs),
// so Dot lists scheduled asks with the house's automations and Lists' reminders (automations.mjs).
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe as describeRule, localParts, nextAfter, parseRule, validZone, zonedToIso, YMD } from './repeat.mjs';
import { asking, pendingIn } from './confirm.mjs';

export const MAX_PER_PERSON = 10;
export const SCHED_ID = /^s[a-z0-9]{8,20}$/;
const LIMITS = { title: 60, ask: 600 };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const CHANNELS = ['sms', 'email'];

const uid = () => 's' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const dayBefore = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - 86_400_000).toISOString().slice(0, 10);

/** The first time this schedule runs after `afterIso`, or null when its series has ended */
export function nextRun({ time, repeat }, afterIso) {
  const [today] = localParts(afterIso, repeat.tz);
  // From the later of its start and today: the occurrence on or after that day, then on from there
  let day = nextAfter(repeat, dayBefore(repeat.start > today ? repeat.start : today));
  let n = repeat.n ?? 0;
  while (day) {
    const at = zonedToIso(day, time, repeat.tz);
    if (at > afterIso) return { at, day };
    day = nextAfter({ ...repeat, n: n++ }, day);
  }
  return null;
}

/** A schedule from Dot's input, checked; throws with a reason. tz: the person's time zone; today: their local date */
export function cleanSchedule(input, { tz, today }) {
  const title = String(input.title ?? '').trim();
  const ask = String(input.ask ?? '').trim();
  if (!title || title.length > LIMITS.title) throw new Error(`title: up to ${LIMITS.title} characters`);
  if (!ask || ask.length > LIMITS.ask) throw new Error(`ask: what to do each time, up to ${LIMITS.ask} characters`);
  if (!TIME.test(input.time ?? '')) throw new Error('time: "HH:MM", 24-hour, their local time');
  const rule = String(input.repeat ?? '').replace(/^RRULE:/i, '').toUpperCase();
  parseRule(rule);
  if (/COUNT=/.test(rule)) throw new Error('repeat: use UNTIL to end it, not COUNT');
  if (!validZone(tz)) throw new Error('time zone');
  const start = input.start ?? today;
  if (!YMD.test(start)) throw new Error('start: YYYY-MM-DD');
  if (input.by !== undefined && !CHANNELS.includes(input.by)) throw new Error('by: sms or email');
  return { title, ask, time: input.time, repeat: { rule, tz, start, n: 0 }, ...(input.by ? { by: input.by } : {}) };
}

const clock = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const BY = { sms: 'by text', email: 'by email' };

/** "Every week on Sunday at 1:00 PM, by text: a budget overview" */
export function describeSchedule(s) {
  const when = describeRule(s.repeat.rule);
  return `${when[0].toUpperCase()}${when.slice(1)} at ${clock(s.time)}, ${BY[s.by]}`;
}

const out = ({ pk: _p, sk, ...s }) => ({ id: sk, ...s, enabled: s.enabled !== false, says: describeSchedule(s) });

const OUTCOME = (r) => (r.ok ? 'done' : /^missed/.test(r.error ?? '') ? 'missed' : 'failed');

/** A scheduled ask (as list() gives it) as an automation, the shape every tool's share */
export function askAutomation(s) {
  const status = !s.enabled ? 'paused' : s.nextAt ? 'on' : 'stopped';
  return {
    id: s.id, kind: 'ask', name: s.title, says: `${s.says}: “${s.ask}”`, status, ...(status === 'stopped' ? { why: 'its last day has passed' } : {}),
    mine: true, can_change: true, last_run: s.lastRun ? { at: s.lastRun.at, outcome: OUTCOME(s.lastRun) } : null, next_at: s.nextAt ?? null,
  };
}

export function makeSchedules({ db, table, now = () => new Date() }) {
  const pk = (sub) => `SCHED#${sub}`;
  async function query(p) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': p }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  const dueKey = (sub, id, at) => ({ pk: 'SCHEDDUE', sk: `${at}#${sub}#${id}` });

  return {
    async list(sub) {
      return (await query(pk(sub))).map(out).sort((a, b) => (a.nextAt ?? '~').localeCompare(b.nextAt ?? '~'));
    },
    async get(sub, id) {
      const r = await db.send(new GetCommand({ TableName: table, Key: { pk: pk(sub), sk: id } }));
      return r.Item ?? null;
    },

    /** Saves a new one (fields from cleanSchedule plus by); -> it */
    async create(sub, fields, { via }) {
      if ((await query(pk(sub))).length >= MAX_PER_PERSON) throw new Error(`They have the most scheduled asks one person can (${MAX_PER_PERSON}); delete one first.`);
      const at = now().toISOString();
      const next = nextRun(fields, at);
      if (!next) throw new Error('That schedule never comes round again.');
      const item = { pk: pk(sub), sk: uid(), ...fields, nextAt: next.at, lastRun: null, createdAt: at, createdVia: via, rev: 1 };
      await db.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      await db.send(new PutCommand({ TableName: table, Item: { ...dueKey(sub, item.sk, item.nextAt), sub, id: item.sk } }));
      return out(item);
    },

    /** Pause (no due row, so it never runs) or resume (from its next time after now); -> it, or null if there's none */
    async setEnabled(sub, id, enabled) {
      for (let tries = 0; tries < 3; tries++) {
        const s = await this.get(sub, id);
        if (!s) return null;
        if ((s.enabled !== false) === enabled) return out(s);
        const next = enabled ? nextRun(s, now().toISOString()) : null;
        const item = { ...s, enabled, nextAt: next?.at ?? null, rev: s.rev + 1 };
        try {
          await db.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': s.rev } }));
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') continue; // the runner moved it on meanwhile: read it again
          throw e;
        }
        if (s.nextAt) await db.send(new DeleteCommand({ TableName: table, Key: dueKey(sub, id, s.nextAt) }));
        if (item.nextAt) await db.send(new PutCommand({ TableName: table, Item: { ...dueKey(sub, id, item.nextAt), sub, id } }));
        return out(item);
      }
      throw new Error('It kept changing; try again.');
    },

    async remove(sub, id) {
      const s = await this.get(sub, id);
      if (!s) return false;
      await db.send(new DeleteCommand({ TableName: table, Key: { pk: pk(sub), sk: id } }));
      if (s.nextAt) await db.send(new DeleteCommand({ TableName: table, Key: dueKey(sub, id, s.nextAt) }));
      return true;
    },

    // ---- for the runner (scheduled.mjs) ----

    /** Index rows due by `atIso` */
    async due(atIso) {
      return (await query('SCHEDDUE')).filter((r) => r.sk.split('#')[0] <= atIso);
    },
    dropDue: (row) => db.send(new DeleteCommand({ TableName: table, Key: { pk: row.pk, sk: row.sk } })),

    /**
     * Claims this run: moves the schedule on to its next time, conditional on its rev, so two
     * runners never both run it. -> the schedule as it was, or null if it changed or is gone
     */
    async claim(row, atIso) {
      const s = await this.get(row.sub, row.id);
      if (!s || s.enabled === false || `${s.nextAt}#${row.sub}#${row.id}` !== row.sk) {
        await this.dropDue(row);
        return null;
      }
      const repeat = { ...s.repeat, n: (s.repeat.n ?? 0) + 1 };
      const next = nextRun({ ...s, repeat }, atIso);
      const claimed = { ...s, repeat, nextAt: next?.at ?? null, rev: s.rev + 1 };
      try {
        await db.send(new PutCommand({ TableName: table, Item: claimed, ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': s.rev } }));
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return null;
        throw e;
      }
      await this.dropDue(row);
      if (claimed.nextAt) await db.send(new PutCommand({ TableName: table, Item: { ...dueKey(row.sub, row.id, claimed.nextAt), sub: row.sub, id: row.id } }));
      return s;
    },

    /** How the run went, on the schedule (if it's still there) */
    async recordRun(sub, id, lastRun) {
      const s = await this.get(sub, id);
      if (!s) return;
      try {
        await db.send(new PutCommand({ TableName: table, Item: { ...s, lastRun, rev: s.rev + 1 }, ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': s.rev } }));
      } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException') throw e; // deleted or changed meanwhile: its own news wins
      }
    },
  };
}

// ---- for Claude ----

export const definition = {
  name: 'schedule',
  description: 'Scheduled asks: something you do for them by yourself, on a schedule, and send them the answer by text or email '
    + '(“text me a budget overview every Sunday at 1”, “every weekday at 7, what’s on my calendar today”). When it runs you can only read '
    + '(calendars, budget, lists, the house), not change anything. list: theirs, with ids. create: title, ask (the request in their words, '
    + 'complete enough to run on its own later), time, repeat, by?. pause, resume, delete: id. Every change asks them first: ask them in plain words '
    + 'and wait for their reply; only if they agree, call again with the same op (and id) and confirm: true. For things the house should do by itself, '
    + 'use the house’s automations (house_automation_create); for a plain reminder, use their lists.',
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['list', 'create', 'pause', 'resume', 'delete'] },
      id: { type: 'string', description: 'For pause, resume, delete: from list' },
      title: { type: 'string', description: 'Short: “Sunday budget overview”' },
      ask: { type: 'string', description: 'What to do each time, as a request to you: “Give me an overview of this month’s budget so far.”' },
      time: { type: 'string', description: '"HH:MM", 24-hour, their local time' },
      repeat: {
        type: 'string',
        description: 'A calendar RRULE (no "RRULE:"): FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, weekly BYDAY=SU or MO,TU,WE,TH,FR, monthly BYMONTHDAY=1 or BYDAY=1MO, '
          + 'UNTIL=YYYYMMDD to end it. At most once a day. Every Sunday: FREQ=WEEKLY;BYDAY=SU',
      },
      start: { type: 'string', description: 'YYYY-MM-DD: the first day it may run (default today)' },
      by: { type: 'string', enum: CHANNELS, description: 'How to send the answer; leave out to use how they’re talking to you now (text, else email)' },
      confirm: { type: 'boolean', description: 'Only after they agreed' },
    },
    required: ['op'],
    additionalProperties: false,
  },
};

/** The handler for one person. contact(): { phone, email } verified, for checking `by` */
export function makeScheduleTool({ schedules, userId, channel, timeZone, contact, audit = async () => {}, now = () => new Date() }) {
  const fields = ['title', 'ask', 'time', 'repeat', 'start', 'by'];
  return async function schedule(input, { history = [] } = {}) {
    const { op } = input;
    if (op === 'list') {
      const mine = await schedules.list(userId);
      return JSON.stringify(mine.map((s) => ({ id: s.id, title: s.title, ask: s.ask, says: s.says, enabled: s.enabled, next: s.nextAt, last_run: s.lastRun })));
    }
    /** The confirmation they were asked for, for this op (and id): exactly that, never a new version from this call */
    const confirmed = () => {
      const p = pendingIn(history, 'schedule');
      if (!p || p.op !== op || (op !== 'create' && p.id !== input.id)) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
      if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
      return p;
    };
    if (op === 'pause' || op === 'resume' || op === 'delete') {
      if (!SCHED_ID.test(input.id ?? '')) throw new Error('id: from list');
      const s = await schedules.get(userId, input.id);
      if (!s) throw new Error('No scheduled ask with that id.');
      if (!input.confirm) {
        await audit({ tool: 'schedule', action: `${op} “${s.title}”`, outcome: 'asked' });
        const verb = { pause: 'Pause', resume: 'Start sending again', delete: 'Delete' }[op];
        return asking('schedule', { ask_them: `${verb} your scheduled ask “${s.title}” (${describeSchedule(s)})?`, op, id: input.id });
      }
      confirmed();
      if (op === 'delete') await schedules.remove(userId, input.id);
      const after = op === 'delete' ? null : await schedules.setEnabled(userId, input.id, op === 'resume');
      await audit({ tool: 'schedule', action: `${op} “${s.title}” (confirmed)`, outcome: 'ok' });
      if (op === 'delete') return 'Deleted: it won’t run again.';
      if (op === 'pause') return 'Paused: it won’t run until they resume it.';
      return after?.nextAt ? `Resumed. Next: ${after.nextAt}.` : 'Resumed, but it has no days left to run.';
    }
    // create
    let pending;
    if (input.confirm) pending = confirmed().schedule;
    const [today] = localParts(now().toISOString(), timeZone);
    const given = pending ?? Object.fromEntries(fields.filter((f) => input[f] !== undefined).map((f) => [f, input[f]]));
    const clean = cleanSchedule(given, { tz: timeZone, today });
    const reach = await contact();
    const by = clean.by ?? (channel === 'email' && reach.email ? 'email' : reach.phone ? 'sms' : 'email');
    if (by === 'sms' && !reach.phone) throw new Error('They have no verified phone number for texts; send it by email, or they can add their number at dot-y.co/sms.');
    if (by === 'email' && !reach.email) throw new Error('They have no verified email address.');
    const s = { ...clean, by };
    if (!pending) {
      const next = nextRun(s, now().toISOString());
      if (!next) throw new Error('That schedule never comes round again.');
      const first = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(next.at));
      await audit({ tool: 'schedule', action: `create “${s.title}”`, outcome: 'asked' });
      return asking('schedule', {
        ask_them: `${describeSchedule(s)}: “${s.ask}” (first on ${first}). Set that up?`,
        op: 'create', schedule: { ...given, by },
      });
    }
    const saved = await schedules.create(userId, s, { via: channel });
    await audit({ tool: 'schedule', action: `create “${saved.title}” (confirmed)`, outcome: 'ok' });
    return `Set up: ${saved.says}. Next: ${saved.nextAt}.`;
  };
}

/** Whether they may still use Dot, and their verified phone and email (Cognito) */
export async function cognitoContact(env, sub) {
  const { CognitoIdentityProviderClient, AdminGetUserCommand, AdminListGroupsForUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const idp = new CognitoIdentityProviderClient({});
  const [u, g] = await Promise.all([
    idp.send(new AdminGetUserCommand({ UserPoolId: env.USER_POOL_ID, Username: sub })),
    idp.send(new AdminListGroupsForUserCommand({ UserPoolId: env.USER_POOL_ID, Username: sub, Limit: 60 })),
  ]);
  const attr = (n) => u.UserAttributes?.find((a) => a.Name === n)?.Value;
  return {
    member: u.Enabled !== false && (g.Groups ?? []).some((x) => x.GroupName === env.GROUP),
    phone: attr('phone_number_verified') === 'true' ? attr('phone_number') : null,
    email: attr('email_verified') === 'true' ? attr('email') : null,
  };
}
