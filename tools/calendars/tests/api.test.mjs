import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { AMBER, KID, LUKE, ROUTES, adminToken, call, dotToken, google, seed, table, token } from './helpers/calendars.mjs';
import { levelsFor } from '../api/api.mjs';

beforeEach(seed);
const ev = (calendar, title = 'Dentist') => ({ calendar, title, start: '2026-10-20T14:00', end: '2026-10-20T15:00' });

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/calendars', undefined, null)).status, 401);
  assert.equal((await call('GET', '/calendars', undefined, forgedToken({ clientId: 'cal-client', group: 'family_calendars' }))).status, 401);
  assert.equal((await call('GET', '/calendars', undefined, token(LUKE, { 'cognito:groups': ['someone_else'] }))).status, 403);
  assert.equal((await call('GET', '/calendars', undefined, token(LUKE, { clientId: 'other-tool' }))).status, 401);
});

test('each person sees their granted calendars, read-only where they may only see', async () => {
  assert.deepEqual((await call('GET', '/calendars')).body.map((c) => [c.calendar, !!c.read_only]), [['amber', true], ['kids', false], ['luke', false]]);
  assert.deepEqual((await call('GET', '/calendars', undefined, token(AMBER))).body.map((c) => [c.calendar, !!c.read_only]), [['amber', true], ['kids', true], ['luke', true]], 'her own calendar too: Google shares it with Dot read-only');
  assert.deepEqual((await call('GET', '/calendars', undefined, token(KID))).body, [], 'no grants, no calendars');
});

test('edit where granted; read-only and ungranted calendars are refused before Google is asked', async () => {
  const made = await call('POST', '/events', ev('kids'));
  assert.equal(made.status, 200);
  google.requests = [];
  assert.equal((await call('POST', '/events', ev('kids'), token(AMBER))).status, 403);
  assert.equal((await call('POST', '/events', ev('luke'), token(KID))).status, 403);
  assert.equal((await call('PUT', `/events/kids/${made.body.id}`, { title: 'x' }, token(AMBER))).status, 403);
  assert.deepEqual(google.requests.filter((r) => r.method !== 'GET'), [], 'nothing reached Google');
  assert.equal((await call('PUT', `/events/kids/${made.body.id}`, { title: 'Dentist (Mia)' })).status, 200);
});

test('Google’s own role wins: an edit grant on a calendar shared read-only stays read-only', async () => {
  await call('PUT', '/grants/g9ambr', { who: `sub:${LUKE}`, calendar: 'amber', level: 'edit' }, adminToken());
  const c = (await call('GET', '/calendars')).body.find((x) => x.calendar === 'amber');
  assert.equal(c.read_only, true);
  assert.equal((await call('POST', '/events', ev('amber'))).status, 403);
});

test('grants by family group and to every calendar; the highest wins', () => {
  const grants = [{ who: 'group:gkids00001', calendar: '*', level: 'read' }, { who: `sub:${KID}`, calendar: 'kids', level: 'edit' }];
  assert.deepEqual(levelsFor({ sub: KID, groupIds: new Set(['gkids00001']) }, grants, ['luke', 'kids']), { luke: 'read', kids: 'edit' });
  assert.deepEqual(levelsFor({ sub: KID, groupIds: new Set() }, grants, ['luke', 'kids']), { luke: 'none', kids: 'edit' });
});

test('the agenda: every calendar they can see, by start time', async () => {
  google.events['kids@group.calendar.google.com'] = [{ id: 'k1', summary: 'Soccer', start: { dateTime: '2026-10-21T22:00:00Z' }, end: { dateTime: '2026-10-21T23:00:00Z' } }];
  google.events['luke.doty@gmail.com'] = [{ id: 'l1', summary: 'Dentist', start: { dateTime: '2026-10-20T14:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } }];
  const r = (await call('GET', '/agenda?days=7')).body;
  assert.deepEqual(r.map((e) => [e.calendar, e.title]), [['luke', 'Dentist'], ['kids', 'Soccer']]);
  assert.equal((await call('GET', '/agenda?days=7', undefined, token(KID))).body.length, 0);
});

test('Dot works as the person; deleting asks first, and only that person’s OK for that event works', async () => {
  const made = (await call('POST', '/events', ev('kids'), dotToken())).body;
  const ask = await call('DELETE', `/events/kids/${made.id}`, undefined, dotToken());
  assert.equal(ask.status, 202);
  assert.equal(google.events['kids@group.calendar.google.com'].length, 1, 'not deleted yet');
  assert.equal((await call('DELETE', `/events/kids/${made.id}?confirm_id=${ask.body.confirm_id}`, undefined, dotToken(AMBER))).status, 400, 'someone else');
  const again = (await call('DELETE', `/events/kids/${made.id}`, undefined, dotToken())).body.confirm_id;
  assert.equal((await call('DELETE', `/events/kids/${made.id}?confirm_id=${again}`, undefined, dotToken())).status, 200);
  assert.equal(google.events['kids@group.calendar.google.com'].length, 0);
  assert.equal((await call('DELETE', `/events/kids/${made.id}?confirm_id=${again}`, undefined, dotToken())).status, 400, 'single use');
});

test('admin: only admins, never through Dot', async () => {
  for (const [m, p, b] of [['GET', '/admin'], ['PUT', '/calendars/x', { googleId: 'luke.doty@gmail.com' }], ['DELETE', '/calendars/kids'], ['PUT', '/grants/gzzzzz', { who: `sub:${KID}`, calendar: 'kids', level: 'read' }], ['DELETE', '/grants/g1luke']]) {
    assert.deepEqual((await call(m, p, b, token(AMBER))).body, { error: 'admins only' }, `${m} ${p}`);
    assert.deepEqual((await call(m, p, b, dotToken())).body, { error: 'read-only' }, `${m} ${p} via Dot`);
  }
});

test('adding a calendar checks it live with Google: shared with Dot, and how', async () => {
  const a = adminToken();
  const r = await call('PUT', '/calendars/school', { googleId: 'nobody@group.calendar.google.com' }, a);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Share it with calendar-manager@/);
  assert.equal((await call('PUT', '/calendars/Bad Name', { googleId: 'luke.doty@gmail.com' }, a)).status, 400);
  assert.equal((await call('PUT', '/calendars/kids', { googleId: 'luke.doty@gmail.com' }, a)).status, 409, 'that name is taken');
  const admin = (await call('GET', '/admin', undefined, a)).body;
  assert.deepEqual(admin.calendars.map((c) => [c.alias, c.name, c.role]), [['amber', 'Amber', 'reader'], ['kids', 'L&A Kids', 'writer'], ['luke', 'Luke Doty', 'owner']]);
  assert.equal(admin.grants.length, 6);
});

test('removing a calendar removes its grants', async () => {
  const r = await call('DELETE', '/calendars/kids', undefined, adminToken());
  assert.deepEqual(r.body.removedGrants.sort(), ['g3kids', 'g4kids']);
  assert.deepEqual((await call('GET', '/calendars')).body.map((c) => c.calendar), ['amber', 'luke']);
});

test('bad grants are refused', async () => {
  const a = adminToken();
  assert.equal((await call('PUT', '/grants/gzzzzz', { who: 'luke', calendar: 'kids', level: 'read' }, a)).status, 400);
  assert.equal((await call('PUT', '/grants/gzzzzz', { who: `sub:${KID}`, calendar: 'nope', level: 'read' }, a)).status, 400);
  assert.equal((await call('PUT', '/grants/gzzzzz', { who: `sub:${KID}`, calendar: 'kids', level: 'owner' }, a)).status, 400);
  assert.equal(table.get('GRANT', 'gzzzzz'), undefined);
});

test('the routes in infra/api.tf match the handler', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
});
