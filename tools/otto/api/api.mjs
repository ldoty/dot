// Otto API: the person's side (a lukes_otto token from Otto's page, or a delegated one from Dot or Claude
// Code, as the person). Otto itself, at home, uses agent.mjs with its own key, never these routes.
//   GET    /dot                     -> this tool's description for Dot and Claude Code (platform/api/dot-manifest.mjs)
//   GET    /status                  -> { agent: { seenAt, online }, queued, running }
//   GET    /commands                -> [command…] newest first, the last 30 days (store.mjs commandOut)
//   POST   /commands                { prompt } -> 201 the command, queued for Otto
//                                     From a delegated token (Dot or Claude Code: the token can't say which):
//                                     202 { confirm_id, prompt, command_id } first. Dot sends the same request
//                                     again with ?confirm_id= only after the person's own reply (same person, same
//                                     prompt, within 2 minutes, once); Claude Code can't, so the person approves it
//                                     on the page instead (within a day). Until then it's `asking` and never runs.
//   POST   /commands/{id}/approve   -> the command, queued: one Dot or Claude Code staged (the page only)
//   DELETE /commands/{id}           -> the command, discarded: one not yet started (the page only)
//   GET    /schedules               -> [automation…] (schedules.mjs automationOf): what Otto runs on its own
//   POST   /schedules               { name, prompt, time, repeat?, enabled? } -> 201 the schedule
//   PATCH  /schedules/{id}          { any of those, rev? } -> the schedule: the given fields over the current ones
//   DELETE /schedules/{id}          -> { id }
//                                     From a delegated token every schedule change answers 202 first, as above:
//                                     a schedule runs later with nobody asking
//   GET    /sent                    -> [{ sentAt, channel, text, about }] emails Otto sent this person, two days
// Why a delegated token can't queue directly: Dot reads texts and email from outside, and the token
// looks the same from Dot and from Claude Code, so only the person's own reply (Dot's confirm.mjs) or
// their own click on the page turns a staged prompt into something Otto runs.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest, writeRoutes } from './dot-manifest.mjs';
import { CMD_ID, KEEP_COMMANDS_S, MAX_PROMPT, commandId, commandOut, makeStore, scheduleId } from './store.mjs';
import { MAX_SCHEDULES, SCHED_ID, automationOf, canonical, cleanSchedule, nextRun } from './schedules.mjs';
import { localParts } from './repeat.mjs';

const CONFIRM_MS = 2 * 60_000;
const APPROVE_MS = 86_400_000; // how long a staged command waits for the person on the page
const MAX_WAITING = 20;        // asking + queued at once: staging can't bury Otto
const ONLINE_MS = 3 * 60_000;  // the agent asks for work every 20 s or so

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const SCHEDULE_FIELDS = {
  name: { type: 'string', maxLength: 60, description: 'Short name, e.g. “Daily brief”' },
  prompt: { type: 'string', maxLength: 4000, description: 'Exactly what Otto is told each time, in full' },
  time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: '24-hour "HH:MM", the family’s local time' },
  repeat: {
    type: 'object',
    description: 'Which days: { "rule": a calendar RRULE (no "RRULE:"), "start"?: "YYYY-MM-DD" }, the same rules as lists and scheduled asks. Leave out for every day. '
      + 'Weekdays: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR. UNTIL=YYYYMMDD ends it (no COUNT)',
  },
};

export const MANIFEST = validateManifest({
  name: 'otto',
  title: 'Otto',
  description: 'Otto, Luke’s agent on the home server: manages his Gmail inbox (reads, labels, archives; never sends from Gmail) and emails him from otto@dot-y.co. Give it work, see what it did, and what it runs on its own.',
  operations: [{
    name: 'commands',
    description: 'What Otto was asked to do in the last 30 days, newest first: each command’s prompt, where it came from (page, asked: through Dot or Claude Code, schedule, email), '
      + 'its status (asking: waiting for the person’s OK; queued; running; done; failed; discarded) and Otto’s answer (result).',
    path: '/commands',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'status',
    description: 'Whether Otto is online at home (it checks in every 20 seconds or so), and how many commands are queued or running.',
    path: '/status',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'stage',
    description: 'Give Otto something to do, in plain words, as a complete instruction (e.g. “Archive everything from Houzz older than a week and tell me how many”). '
      + 'It always asks the person first; from Claude Code they approve it on Otto’s page.',
    method: 'POST',
    path: '/commands',
    input: { type: 'object', properties: { prompt: { type: 'string', maxLength: MAX_PROMPT } }, required: ['prompt'], additionalProperties: false },
  }, {
    name: 'schedules',
    description: 'What Otto runs on its own, and when (e.g. every day at 6:00 AM, the daily brief): each schedule’s id, name, what it does in words (says), its prompt, time, days (repeat), '
      + 'whether it’s on, paused or stopped, when it runs next and how its last run went. To make, change or delete one, use otto_schedule_create, _change or _delete.',
    path: '/schedules',
    role: 'automations',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'sent',
    description: 'Emails Otto sent this person in the last two days, newest first. When they reply to one, find it here.',
    path: '/sent',
    role: 'sent',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'schedule_create',
    description: 'Have Otto run a prompt on its own at a time, on the days of a repeat rule (every day if left out). It always asks them first.',
    method: 'POST',
    path: '/schedules',
    input: { type: 'object', properties: SCHEDULE_FIELDS, required: ['name', 'prompt', 'time'], additionalProperties: false },
  }, {
    name: 'schedule_change',
    description: 'Change, pause (enabled: false) or resume (enabled: true) one of Otto’s schedules, by its id from otto_schedules: only the fields given change. It always asks them first.',
    method: 'PATCH',
    path: '/schedules/{id}',
    input: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^s[a-z0-9]{10}$' }, ...SCHEDULE_FIELDS, enabled: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  }, {
    name: 'schedule_delete',
    description: 'Delete one of Otto’s schedules, by its id from otto_schedules. It always asks them first.',
    method: 'DELETE',
    path: '/schedules/{id}',
    input: { type: 'object', properties: { id: { type: 'string', pattern: '^s[a-z0-9]{10}$' } }, required: ['id'], additionalProperties: false },
  }],
});

const DELEGATED_WRITES = writeRoutes(MANIFEST);

/** deps: db, table, group, issuer, clientIds, dotClientId, now(), timeZone */
export function createApi(deps) {
  const store = makeStore({ db: deps.db, table: deps.table });
  const { get, all, putAt, put, del } = store;
  const now = () => deps.now();

  /**
   * A delegated change waits for the person's OK. Without a confirm id: remember what was asked, answer
   * 202. With one: true if it fits (same person, op, target and content, in time, once), else a response.
   */
  async function confirmed(who, op, target, body, confirmId, prompt, extra = {}) {
    const t = now().getTime();
    if (!confirmId) {
      const cid = randomBytes(12).toString('hex');
      await put({ pk: 'PENDING', sk: cid, who, op, target, body, until: t + CONFIRM_MS, expires: Math.floor(t / 1000) + 86_400 });
      return json(202, { confirm_id: cid, prompt, ...extra });
    }
    const p = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
    if (p) await del('PENDING', confirmId);
    if (!p || p.who !== who || p.op !== op || p.target !== target || p.body !== body || p.until < t) {
      return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
    }
    return true;
  }

  const waiting = async () => (await all('CMD')).filter((r) => r.status === 'asking' || r.status === 'queued').length;

  async function stage(claims, delegated, body, confirmId) {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT) return json(400, { error: `prompt: what Otto should do, up to ${MAX_PROMPT} characters` });
    const t = now();
    if (delegated && confirmId) {
      // The person said yes in Dot: the command staged when Dot asked, now queued
      const pending = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
      const ok = await confirmed(claims.sub, 'command', pending?.target ?? '', prompt, confirmId, '');
      if (ok !== true) return ok;
      const row = await get('CMD', pending.target);
      if (!row || row.status !== 'asking') return json(409, { error: 'that command was already approved or discarded' });
      const item = { ...row, status: 'queued', approvedAt: t.toISOString(), approvedVia: 'reply', rev: row.rev + 1 };
      if (!(await putAt(item, row.rev))) return json(409, { error: 'that command changed meanwhile' });
      console.log('command approved', JSON.stringify({ id: row.sk, by: claims.username, via: 'reply' }));
      return json(200, commandOut(item));
    }
    if ((await waiting()) >= MAX_WAITING) return json(429, { error: `Otto already has ${MAX_WAITING} commands waiting` });
    const id = commandId(t);
    const item = {
      pk: 'CMD', sk: id, prompt, source: delegated ? 'asked' : 'page', status: delegated ? 'asking' : 'queued',
      by: claims.username, createdAt: t.toISOString(), rev: 1, expires: Math.floor(t.getTime() / 1000) + KEEP_COMMANDS_S,
    };
    await putAt(item);
    console.log('command staged', JSON.stringify({ id, by: claims.username, delegated }));
    if (!delegated) return json(201, commandOut(item));
    const short = prompt.length > 300 ? `${prompt.slice(0, 299)}…` : prompt;
    return confirmed(claims.sub, 'command', id, prompt, null, `Have Otto do this? “${short}”`, { command_id: id });
  }

  /** The page's approve or discard of one command */
  async function decide(claims, id, to) {
    if (!CMD_ID.test(id ?? '')) return json(404, { error: 'no such command' });
    const row = await get('CMD', id);
    if (!row) return json(404, { error: 'no such command' });
    const t = now();
    if (to === 'queued') {
      if (row.status !== 'asking') return json(409, { error: `it’s ${row.status}, not waiting for your OK` });
      if (t.getTime() - Date.parse(row.createdAt) > APPROVE_MS) return json(409, { error: 'it waited over a day; stage it again' });
    } else if (!['asking', 'queued'].includes(row.status)) {
      return json(409, { error: `it’s already ${row.status}` });
    }
    const item = { ...row, status: to, rev: row.rev + 1, ...(to === 'queued' ? { approvedAt: t.toISOString(), approvedVia: 'page' } : { finishedAt: t.toISOString() }) };
    if (!(await putAt(item, row.rev))) return json(409, { error: 'it changed meanwhile; reload' });
    console.log(to === 'queued' ? 'command approved' : 'command discarded', JSON.stringify({ id, by: claims.username, via: 'page' }));
    return json(200, commandOut(item));
  }

  async function changeSchedule(op, claims, delegated, id, body, confirmId) {
    const t = now();
    const tz = deps.timeZone;
    const today = localParts(t.toISOString(), tz)[0];
    if (op === 'create') {
      const asked = delegated && confirmId && /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
      id = asked?.target ?? scheduleId();
    } else if (!SCHED_ID.test(id ?? '')) {
      return json(404, { error: 'no such schedule' });
    }
    const row = op === 'create' ? null : await get('SCHED', id);
    if (op !== 'create' && !row) return json(404, { error: 'no such schedule' });

    if (op === 'delete') {
      if (delegated) {
        const ok = await confirmed(claims.sub, op, id, '', confirmId, `Delete Otto’s schedule “${row.name}”?`);
        if (ok !== true) return ok;
      }
      await del('SCHED', id);
      console.log('schedule removed', JSON.stringify({ id, by: claims.username, delegated }));
      return json(200, { id });
    }

    const given = op === 'patch'
      ? { name: row.name, prompt: row.prompt, time: row.time, repeat: row.repeat, enabled: row.enabled, ...Object.fromEntries(['name', 'prompt', 'time', 'repeat', 'enabled'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) }
      : body;
    if (op === 'patch' && body.repeat === undefined) given.repeat = { rule: row.repeat.rule, start: row.repeat.start };
    let s;
    try {
      s = cleanSchedule(given, { tz, today, row });
    } catch (e) {
      return json(400, { error: `bad ${e.message}` });
    }
    if (op === 'patch' && body.rev !== undefined && body.rev !== row.rev) return json(409, { error: 'changed meanwhile', current: automationOf(row, claims.sub) });
    if (op === 'create' && (await all('SCHED')).length >= MAX_SCHEDULES) return json(400, { error: `Otto has the most schedules it can (${MAX_SCHEDULES})` });
    if (delegated) {
      const prompt = op === 'create' ? `Save Otto’s schedule “${s.name}” (${s.time}, ${s.repeat.rule}): “${s.prompt.slice(0, 300)}”?`
        : `Change Otto’s schedule “${row.name}” to “${s.name}” at ${s.time}, ${s.repeat.rule}${s.enabled ? '' : ' (paused)'}: “${s.prompt.slice(0, 300)}”?`;
      const ok = await confirmed(claims.sub, op, id, `${row?.rev ?? ''}|${canonical(s)}`, confirmId, prompt, op === 'create' ? { schedule_id: id } : {});
      if (ok !== true) return ok;
    }
    const item = {
      pk: 'SCHED', sk: id, ...s, nextAt: s.enabled ? nextRun(s, t.toISOString()) : null,
      ...(row?.lastRun ? { lastRun: row.lastRun } : {}),
      owner: row?.owner ?? claims.sub, rev: (row?.rev ?? 0) + 1, changedBy: claims.username, changedAt: t.toISOString(),
    };
    if (!(await putAt(item, row?.rev))) {
      const cur = await get('SCHED', id);
      return json(409, { error: op === 'create' ? 'that schedule already exists' : 'changed meanwhile', current: cur ? automationOf(cur, claims.sub) : null });
    }
    console.log('schedule saved', JSON.stringify({ id, by: claims.username, delegated, enabled: s.enabled }));
    return json(op === 'create' ? 201 : 200, automationOf(item, claims.sub));
  }

  return async function handler(event) {
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientIds, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const delegated = claims.via === 'dot' || (!!deps.dotClientId && claims.client_id === deps.dotClientId);
    const route = event.routeKey;
    if (delegated && !route?.startsWith('GET ') && !DELEGATED_WRITES.includes(route)) {
      console.warn('denied: read-only for a delegated token', route, claims.username);
      return json(403, { error: 'read-only' });
    }
    let body = {};
    if (event.body && !route.startsWith('GET ') && !route.startsWith('DELETE ')) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad json' });
    }
    const id = event.pathParameters?.id;
    const confirmId = event.queryStringParameters?.confirm_id;

    switch (route) {
      case 'GET /dot':
        return json(200, MANIFEST);
      case 'GET /status': {
        const [seen, cmds] = await Promise.all([get('AGENT', 'SEEN'), all('CMD')]);
        const seenAt = seen?.at ?? null;
        return json(200, {
          agent: { seenAt, online: !!seenAt && now().getTime() - Date.parse(seenAt) < ONLINE_MS },
          queued: cmds.filter((r) => r.status === 'queued').length, running: cmds.filter((r) => r.status === 'running').length,
          asking: cmds.filter((r) => r.status === 'asking').length,
        });
      }
      case 'GET /commands':
        return json(200, (await all('CMD')).sort((a, b) => (a.sk < b.sk ? 1 : -1)).map(commandOut));
      case 'POST /commands':
        return stage(claims, delegated, body, confirmId);
      case 'POST /commands/{id}/approve':
        return decide(claims, id, 'queued');
      case 'DELETE /commands/{id}':
        return decide(claims, id, 'discarded');
      case 'GET /schedules':
        return json(200, (await all('SCHED')).map((r) => automationOf(r, claims.sub)).sort((a, b) => a.name.localeCompare(b.name)));
      case 'POST /schedules':
        return changeSchedule('create', claims, delegated, null, body, confirmId);
      case 'PATCH /schedules/{id}':
        return changeSchedule('patch', claims, delegated, id, body, confirmId);
      case 'DELETE /schedules/{id}':
        return changeSchedule('delete', claims, delegated, id, {}, confirmId);
      case 'GET /sent': {
        const t = now().getTime();
        const days = [0, 1, 2].map((d) => new Date(t - d * 86_400_000).toISOString().slice(0, 10));
        const sent = (await Promise.all(days.map((d) => all(`SENT#${d}`)))).flat()
          .filter((r) => r.toSub === claims.sub && t - Date.parse(r.sentAt) < 2 * 86_400_000)
          .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
        return json(200, sent.map((r) => ({ sentAt: r.sentAt, channel: 'email', text: `${r.subject}: ${r.text}`.slice(0, 600), about: 'Otto' })));
      }
      default:
        return json(404, { error: 'no route' });
    }
  };
}

let live;
export const handler = async (event) => (live ??= createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  table: process.env.TABLE, group: process.env.GROUP, issuer: process.env.ISSUER,
  clientIds: [process.env.CLIENT_ID, process.env.DOT_CLIENT_ID].filter(Boolean), dotClientId: process.env.DOT_CLIENT_ID,
  now: () => new Date(), timeZone: process.env.TIME_ZONE || 'America/New_York',
}))(event);
