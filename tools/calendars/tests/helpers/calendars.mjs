// The Calendars API on the fake table, with the family's groups on the same table and a fake
// Google that records requests and keeps events in memory per calendar.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';
import { makePeople } from '../../api/people.mjs';

export const table = fakeTable({ pageSize: 2 });
const { createApi } = await import('../../api/api.mjs');

export const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
export const AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07';
export const KID = '11111111-1111-1111-1111-111111111111';
export const ROUTES = [
  'GET /calendars', 'GET /events', 'GET /agenda', 'POST /events', 'PUT /events/{calendar}/{eventId}', 'DELETE /events/{calendar}/{eventId}',
  'GET /admin', 'PUT /calendars/{alias}', 'DELETE /calendars/{alias}', 'PUT /grants/{id}', 'DELETE /grants/{id}',
];

/** Google, as far as these tests need it: calendars Dot's account can see, with a role each */
export const google = {
  calendars: {
    'luke.doty@gmail.com': { summary: 'Luke Doty', role: 'owner' },
    'kids@group.calendar.google.com': { summary: 'L&A Kids', role: 'writer' },
    'amber@gmail.com': { summary: 'Amber', role: 'reader' },
  },
  events: {}, // googleId -> [event]
  requests: [],
};
let seq = 0;
async function googleFetch(url, o = {}) {
  const u = new URL(url), method = o.method || 'GET', body = o.body ? JSON.parse(o.body) : undefined;
  google.requests.push({ method, path: decodeURIComponent(u.pathname), body });
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const no = (status) => ({ ok: false, status, json: async () => ({ error: { message: 'nope' } }) });
  let m = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(u.pathname);
  if (m) { const c = google.calendars[decodeURIComponent(m[1])]; return c ? ok({ summary: c.summary, timeZone: 'America/New_York' }) : no(404); }
  if (u.pathname === '/calendar/v3/users/me/calendarList' && method === 'POST') { const c = google.calendars[body.id]; return c ? ok({ accessRole: c.role }) : no(404); }
  m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
  if (m) {
    const id = decodeURIComponent(m[1]), list = (google.events[id] ??= []);
    if (method === 'GET') return ok({ items: list });
    if (method === 'POST') { const e = { id: `e${++seq}`, ...body }; list.push(e); return ok(e); }
    const ev = list.find((e) => e.id === decodeURIComponent(m[2]));
    if (!ev) return no(404);
    if (method === 'PATCH') { Object.assign(ev, body); return ok(ev); }
    if (method === 'DELETE') { list.splice(list.indexOf(ev), 1); return { ok: true, status: 204, json: async () => ({}) }; }
  }
  return no(400);
}

export const clock = { now: new Date('2026-10-19T14:00:00Z') };
export const handler = createApi({
  table: 'family-calendars', group: 'family_calendars', issuer: ISSUER,
  clientIds: ['cal-client', 'cal-via-dot'], dotClientId: 'cal-via-dot',
  people: makePeople({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-people', ttlMs: 0 }),
  members: async () => [{ sub: LUKE, name: 'Luke' }, { sub: AMBER, name: 'amber@x.test' }, { sub: KID, name: 'Kid' }],
  google: { accessToken: async () => 'gtok', fetch: googleFetch }, timeZone: 'America/New_York', now: () => clock.now,
});

export const token = (sub = LUKE, over = {}) => accessToken({ clientId: 'cal-client', sub, 'cognito:groups': ['family_calendars'], ...over });
export const adminToken = () => token(LUKE, { 'cognito:groups': ['family_calendars', 'family_calendars:admin'] });
export const dotToken = (sub = LUKE) => token(sub, { clientId: 'cal-via-dot', via: 'dot' });
const callApi = caller(handler, ROUTES);
export const call = (m, p, b, t = token()) => callApi(m, p, b, t);

/** Today's setup: luke and kids (Luke edits, Amber sees), amber (Amber edits, Luke sees) */
export async function seed() {
  table.clear();
  google.events = {}; google.requests = [];
  clock.now = new Date('2026-10-19T14:00:00Z');
  const a = adminToken();
  await call('PUT', '/calendars/luke', { googleId: 'luke.doty@gmail.com' }, a);
  await call('PUT', '/calendars/kids', { googleId: 'kids@group.calendar.google.com' }, a);
  await call('PUT', '/calendars/amber', { googleId: 'amber@gmail.com' }, a);
  const grants = [['g1luke', LUKE, 'luke', 'edit'], ['g2luke', AMBER, 'luke', 'read'], ['g3kids', LUKE, 'kids', 'edit'], ['g4kids', AMBER, 'kids', 'read'], ['g5ambr', AMBER, 'amber', 'edit'], ['g6ambr', LUKE, 'amber', 'read']];
  for (const [id, sub, calendar, level] of grants) await call('PUT', `/grants/${id}`, { who: `sub:${sub}`, calendar, level }, a);
}
