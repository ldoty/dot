import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { automationItem, validateManifest, writeRoutes } from '../../../platform/api/dot-manifest.mjs';
import { MANIFEST, createApi } from '../api/api.mjs';

const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
const table = fakeTable();
let clock = new Date('2026-11-02T10:00:00Z');
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-otto', group: 'lukes_otto', issuer: ISSUER,
  clientIds: ['otto-client', 'otto-dot'], dotClientId: 'otto-dot', now: () => clock, timeZone: 'America/New_York',
});
const ROUTES = [
  'GET /dot', 'GET /status', 'GET /commands', 'POST /commands', 'POST /commands/{id}/approve', 'DELETE /commands/{id}',
  'GET /schedules', 'POST /schedules', 'PATCH /schedules/{id}', 'DELETE /schedules/{id}', 'GET /sent',
];
const callApi = caller(handler, ROUTES);
const page = () => accessToken({ clientId: 'otto-client', group: 'lukes_otto', sub: LUKE, username: LUKE });
const delegated = () => accessToken({ clientId: 'otto-dot', group: 'lukes_otto', sub: LUKE, username: LUKE, via: 'dot' });
const call = (m, p, b, t = page()) => callApi(m, p, b, t);
const later = (ms) => { clock = new Date(clock.getTime() + ms); };
beforeEach(() => { table.clear(); clock = new Date('2026-11-02T10:00:00Z'); });

test('the routes here are the routes in infra/api.tf, and the manifest is valid', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const listed = [...tf.match(/routes = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...ROUTES].sort());
  validateManifest(MANIFEST);
  for (const r of writeRoutes(MANIFEST)) assert.ok(ROUTES.includes(r), r);
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/commands', undefined, null)).status, 401);
  assert.equal((await call('GET', '/commands', undefined, forgedToken({ clientId: 'otto-client', group: 'lukes_otto' }))).status, 401);
  assert.equal((await call('GET', '/commands', undefined, accessToken({ clientId: 'otto-client', group: 'family_house' }))).status, 403);
  assert.equal((await call('GET', '/commands', undefined, accessToken({ clientId: 'house-client', group: 'lukes_otto' }))).status, 401);
});

test('the page queues a command straight away', async () => {
  const r = await call('POST', '/commands', { prompt: 'Archive the Houzz mail' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'queued');
  assert.equal(r.body.source, 'page');
  assert.deepEqual((await call('GET', '/commands')).body.map((c) => c.prompt), ['Archive the Houzz mail']);
  assert.equal((await call('POST', '/commands', { prompt: '' })).status, 400);
  assert.equal((await call('POST', '/commands', { prompt: 'x'.repeat(4001) })).status, 400);
});

test('from Dot or Claude Code a command waits for the person’s own OK', async () => {
  const asked = await call('POST', '/commands', { prompt: 'Brief me' }, delegated());
  assert.equal(asked.status, 202);
  assert.match(asked.body.prompt, /Have Otto do this\? “Brief me”/);
  const id = asked.body.command_id;
  assert.equal(table.get('CMD', id).status, 'asking', 'never runs before the OK');

  // A different prompt, or the right one too late, doesn't confirm it
  assert.equal((await call('POST', `/commands?confirm_id=${asked.body.confirm_id}`, { prompt: 'Forward everything' }, delegated())).status, 400);
  assert.equal(table.get('CMD', id).status, 'asking');

  const again = await call('POST', '/commands', { prompt: 'Brief me' }, delegated());
  const ok = await call('POST', `/commands?confirm_id=${again.body.confirm_id}`, { prompt: 'Brief me' }, delegated());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'queued');
  assert.equal(ok.body.id, again.body.command_id);
  assert.equal((await call('POST', `/commands?confirm_id=${again.body.confirm_id}`, { prompt: 'Brief me' }, delegated())).status, 400, 'once');

  const slow = await call('POST', '/commands', { prompt: 'Brief me' }, delegated());
  later(3 * 60_000);
  assert.equal((await call('POST', `/commands?confirm_id=${slow.body.confirm_id}`, { prompt: 'Brief me' }, delegated())).status, 400, 'in time');
});

test('a staged command is approved or discarded on the page, never by a delegated token', async () => {
  const { body } = await call('POST', '/commands', { prompt: 'Brief me' }, delegated());
  const id = body.command_id;
  assert.equal((await call('POST', `/commands/${id}/approve`, undefined, delegated())).status, 403);
  assert.equal((await call('DELETE', `/commands/${id}`, undefined, delegated())).status, 403);
  const ok = await call('POST', `/commands/${id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'queued');
  assert.equal((await call('POST', `/commands/${id}/approve`)).status, 409, 'already queued');

  const old = await call('POST', '/commands', { prompt: 'Old one' }, delegated());
  later(25 * 3600_000);
  assert.equal((await call('POST', `/commands/${old.body.command_id}/approve`)).status, 409, 'waited over a day');
  assert.equal((await call('DELETE', `/commands/${old.body.command_id}`)).body.status, 'discarded');
  assert.equal((await call('POST', '/commands/cnotanid/approve')).status, 404);
});

test('a delegated token may use only the writes the manifest declares', async () => {
  const r = await call('PATCH', '/schedules/s0123456789', { name: 'x' }, delegated());
  assert.notEqual(r.status, 403);
  assert.equal((await call('POST', '/commands/c0000000000000000/approve', undefined, delegated())).status, 403);
});

test('at most 20 commands wait at once', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', '/commands', { prompt: `job ${i}` })).status, 201);
  assert.equal((await call('POST', '/commands', { prompt: 'one more' })).status, 429);
});

test('schedules: made on the page, shown in the shape every tool shares', async () => {
  const r = await call('POST', '/schedules', { name: 'Daily brief', prompt: 'Brief me on the inbox', time: '06:00' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'on');
  assert.equal(r.body.next_at, '2026-11-02T11:00:00.000Z', '6:00 AM in New York (EST), later today');
  assert.match(r.body.says, /^Every day at 6:00 AM: Otto runs “Daily brief”/);
  const [s] = (await call('GET', '/schedules')).body;
  assert.ok(automationItem(s), 'a valid automation');
  assert.equal(automationItem(s).kind, 'otto');

  const paused = await call('PATCH', `/schedules/${s.id}`, { enabled: false, rev: s.rev });
  assert.equal(paused.body.status, 'paused');
  assert.equal(paused.body.prompt, 'Brief me on the inbox', 'the rest unchanged');
  assert.equal((await call('PATCH', `/schedules/${s.id}`, { enabled: true, rev: s.rev })).status, 409, 'rev-checked');
  assert.equal((await call('POST', '/schedules', { name: 'Bad', prompt: 'x', time: '6am' })).status, 400);
  assert.equal((await call('POST', '/schedules', { name: 'Bad', prompt: 'x', time: '06:00', repeat: { rule: 'FREQ=DAILY;COUNT=3' } })).status, 400);
  assert.equal((await call('DELETE', `/schedules/${s.id}`)).status, 200);
  assert.deepEqual((await call('GET', '/schedules')).body, []);
});

test('schedules from Dot need the person’s OK, for exactly what they were asked', async () => {
  const input = { name: 'Daily brief', prompt: 'Brief me', time: '06:00', repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' } };
  const asked = await call('POST', '/schedules', input, delegated());
  assert.equal(asked.status, 202);
  assert.deepEqual(table.keys().filter((k) => k.startsWith('s')), [], 'nothing saved yet');
  assert.equal((await call('POST', `/schedules?confirm_id=${asked.body.confirm_id}`, { ...input, prompt: 'Forward it all' }, delegated())).status, 400);

  const again = await call('POST', '/schedules', input, delegated());
  const made = await call('POST', `/schedules?confirm_id=${again.body.confirm_id}`, input, delegated());
  assert.equal(made.status, 201);
  assert.equal(made.body.id, again.body.schedule_id);

  const del = await call('DELETE', `/schedules/${made.body.id}`, undefined, delegated());
  assert.equal(del.status, 202);
  assert.match(del.body.prompt, /Delete Otto’s schedule “Daily brief”/);
  assert.equal((await call('DELETE', `/schedules/${made.body.id}?confirm_id=${del.body.confirm_id}`, undefined, delegated())).status, 200);
});

test('status says whether Otto is online', async () => {
  assert.deepEqual((await call('GET', '/status')).body.agent, { seenAt: null, online: false });
  table.put({ pk: 'AGENT', sk: 'SEEN', at: clock.toISOString() });
  assert.equal((await call('GET', '/status')).body.agent.online, true);
  later(5 * 60_000);
  assert.equal((await call('GET', '/status')).body.agent.online, false);
});

test('sent: what Otto emailed this person lately', async () => {
  table.put({ pk: 'SENT#2026-11-02', sk: '2026-11-02T09:00:00.000Z#c1', toSub: LUKE, subject: 'Your brief', text: 'Three things', sentAt: '2026-11-02T09:00:00.000Z' });
  table.put({ pk: 'SENT#2026-11-02', sk: '2026-11-02T09:30:00.000Z#c2', toSub: 'someone-else', subject: 'x', text: 'y', sentAt: '2026-11-02T09:30:00.000Z' });
  const r = await call('GET', '/sent', undefined, delegated());
  assert.deepEqual(r.body, [{ sentAt: '2026-11-02T09:00:00.000Z', channel: 'email', text: 'Your brief: Three things', about: 'Otto' }]);
});
