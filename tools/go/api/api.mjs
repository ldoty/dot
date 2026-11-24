// Go API (a lukes_go token). Routes:
//   GET  /summary                        -> { kinds, themes, profile, today, streak, week } what's due, the error
//                                           database (his mistakes by kind) and how the drills are going
//   GET  /study?kind=<k>[&theme=<t>][&mine=1] -> { due: [drill…], new: [drill…], newLeft } what to drill now: every
//                                           due one (oldest first), then new ones up to today's limit
//   POST /drills/{kind}/{id}/review      { grade, ms?, ok?, err? } -> { schedule }
// Drills are written by scripts/upload.mjs from the KataGo analysis of his games (scripts/), never by the
// page; the page only reads them and reviews them. The token is re-verified here (signature, issuer, client,
// expiry, group); API Gateway's authorizer is not trusted on its own.
//
// Rows: DRILL#<kind> / <id>    { kind, theme, size, stones, toMove, last, answers…, sched, rev } (kinds below)
//       STAT / <local date>    { n, miss, ms, kinds: { <kind>: { n, miss, err } }, themes: { <theme>: { n, miss } }, rev }
//       PROFILE / mistakes     { games, moves, byKind: { <kind>: { n, points } }, at } (from scripts/classify.mjs)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { GRADES, isDue, isNew, review } from './schedule.mjs';

//   fix      find a better move than the one played (his mistakes, and his opponents'); theme = the kind of mistake
//   threat   the opponent just played: where's the threat?
//   count    who's ahead, and by how much?
//   tsumego  life and death, from OGS collections
export const KINDS = ['fix', 'threat', 'count', 'tsumego'];
export const NEW_PER_DAY = 30;
const MAX_STUDY = 100;
const ID = /^[A-Za-z0-9-]{1,40}$/;
const THEME = /^[a-z_]{1,30}$/;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
/** A local date, YYYY-MM-DD */
const dayIn = (t, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** deps: db, table, group, issuer, clientIds, now(), timeZone */
export function createApi(deps) {
  const { db, table } = deps;
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  async function all(pk) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  async function putAt(item, rev) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: item,
        ...(rev === undefined
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  const nowIso = () => deps.now().toISOString();
  const today = () => dayIn(deps.now(), deps.timeZone);
  const out = ({ pk, ...d }) => ({ ...d, id: d.sk, sk: undefined });
  const seenToday = (drills) => {
    const day = today();
    return drills.filter((d) => d.sched?.seen && dayIn(new Date(d.sched.seen), deps.timeZone) === day).length;
  };

  async function study(kind, theme, mine) {
    const drills = (await all(`DRILL#${kind}`)).filter((d) => (!theme || d.theme === theme) && (!mine || d.mine));
    const t = nowIso();
    // Today's new ones count against the limit across every kind
    const introduced = (await Promise.all(KINDS.map((k) => (k === kind ? drills : all(`DRILL#${k}`))))).reduce((n, ds) => n + seenToday(ds), 0);
    const newLeft = Math.max(0, NEW_PER_DAY - introduced);
    const due = drills.filter((d) => isDue(d.sched, t)).sort((a, b) => (a.sched.due < b.sched.due ? -1 : 1)).slice(0, MAX_STUDY);
    // New ones: his own positions first, the costliest first, so the first drills are the ones that matter most
    const fresh = drills.filter((d) => isNew(d.sched))
      .sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || (b.loss ?? b.cost ?? 0) - (a.loss ?? a.cost ?? 0) || (a.sk < b.sk ? -1 : 1))
      .slice(0, newLeft);
    return json(200, { due: due.map(out), new: fresh.map(out), newLeft });
  }

  async function record(kind, theme, grade, ms, err) {
    const day = today(), miss = grade === 'again' ? 1 : 0;
    for (let i = 0; i < 5; i++) {
      const row = await get('STAT', day);
      const k = row?.kinds?.[kind] ?? { n: 0, miss: 0, err: 0 };
      const th = row?.themes?.[theme] ?? { n: 0, miss: 0 };
      const item = {
        pk: 'STAT', sk: day, n: (row?.n ?? 0) + 1, miss: (row?.miss ?? 0) + miss, ms: (row?.ms ?? 0) + ms,
        kinds: { ...row?.kinds, [kind]: { n: k.n + 1, miss: k.miss + miss, err: Math.round((k.err + (err ?? 0)) * 10) / 10 } },
        themes: theme ? { ...row?.themes, [theme]: { n: th.n + 1, miss: th.miss + miss } } : (row?.themes ?? {}),
        rev: (row?.rev ?? 0) + 1,
      };
      if (await putAt(item, row?.rev)) return;
    }
  }

  async function summary() {
    const [lists, stats, profile] = await Promise.all([Promise.all(KINDS.map((k) => all(`DRILL#${k}`))), all('STAT'), get('PROFILE', 'mistakes')]);
    const t = nowIso();
    const tally = (ds) => ({ total: ds.length, due: ds.filter((d) => isDue(d.sched, t)).length, new: ds.filter((d) => isNew(d.sched)).length, mine: ds.filter((d) => d.mine).length });
    const kinds = Object.fromEntries(KINDS.map((k, i) => [k, tally(lists[i])]));
    const themes = {};
    for (const d of lists[0]) (themes[d.theme] ??= []).push(d);
    const byDay = new Map(stats.map((s) => [s.sk, s]));
    const day = today();
    // Days in a row with a drill, counting back from today (or yesterday, if today hasn't started yet)
    let streak = 0;
    let d = byDay.has(day) ? day : dayIn(new Date(deps.now().getTime() - 86_400_000), deps.timeZone);
    while (byDay.has(d)) {
      streak++;
      d = dayIn(new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000), 'UTC');
    }
    // The last 7 days, added up: how often each kind and theme was missed, and the average counting error
    const weekAgo = dayIn(new Date(deps.now().getTime() - 6 * 86_400_000), deps.timeZone);
    const week = { kinds: {}, themes: {} };
    for (const s of stats.filter((x) => x.sk >= weekAgo)) {
      for (const [k, v] of Object.entries(s.kinds ?? {})) { const w = (week.kinds[k] ??= { n: 0, miss: 0, err: 0 }); w.n += v.n; w.miss += v.miss; w.err += v.err ?? 0; }
      for (const [k, v] of Object.entries(s.themes ?? {})) { const w = (week.themes[k] ??= { n: 0, miss: 0 }); w.n += v.n; w.miss += v.miss; }
    }
    const s = byDay.get(day);
    return json(200, {
      kinds,
      themes: Object.fromEntries(Object.entries(themes).map(([k, ds]) => [k, tally(ds)])),
      profile: profile ? { games: profile.games, moves: profile.moves, byKind: profile.byKind, at: profile.at } : null,
      today: { n: s?.n ?? 0, miss: s?.miss ?? 0, minutes: Math.round((s?.ms ?? 0) / 60_000) },
      streak, week,
    });
  }

  return async function handler(event) {
    try {
      await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientIds, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const route = event.routeKey;
    let body = {};
    if (event.body && route.startsWith('POST ')) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad json' });
    }
    const p = event.pathParameters ?? {};
    if ((p.kind !== undefined && !KINDS.includes(p.kind)) || (p.id !== undefined && !ID.test(p.id))) return json(404, { error: 'not found' });

    switch (route) {
      case 'GET /summary':
        return summary();
      case 'GET /study': {
        const q = event.queryStringParameters ?? {};
        if (!KINDS.includes(q.kind)) return json(400, { error: `kind: ${KINDS.join(', ')}` });
        if (q.theme && !THEME.test(q.theme)) return json(400, { error: 'theme' });
        return study(q.kind, q.theme || null, q.mine === '1');
      }
      case 'POST /drills/{kind}/{id}/review': {
        const { grade } = body;
        if (!GRADES.includes(grade)) return json(400, { error: `grade: ${GRADES.join(', ')}` });
        const ms = Number.isFinite(body.ms) ? Math.min(Math.max(0, Math.round(body.ms)), 10 * 60_000) : 0;
        const err = Number.isFinite(body.err) ? Math.min(Math.abs(body.err), 100) : undefined;
        // Saved against the drill as it is now, retried if something else saved it meanwhile
        for (let i = 0; i < 3; i++) {
          const row = await get(`DRILL#${p.kind}`, p.id);
          if (!row) return json(404, { error: 'no such drill' });
          const schedule = review(row.sched, grade, deps.now());
          if (await putAt({ ...row, sched: schedule, rev: (row.rev ?? 0) + 1 }, row.rev)) {
            await record(p.kind, row.theme, grade, ms, err);
            return json(200, { schedule });
          }
        }
        return json(409, { error: 'the drill kept changing; try again' });
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
  clientIds: [process.env.CLIENT_ID], now: () => new Date(), timeZone: process.env.TIME_ZONE || 'America/New_York',
}))(event);
