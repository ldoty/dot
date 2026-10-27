import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, ROUTES, call, cfgRecord, clock, handler, memberToken, post, reading, table } from './helpers/chamber.mjs';

const HOUR = 3600e3;
const ago = (ms) => new Date(Date.now() - ms);
// A stored reading, as ingest writes it
const stored = (at, fields) => table.put({ pk: `R#${at.toISOString().slice(0, 10)}`, sk: at.toISOString(), ...fields, expires: 1 });

beforeEach(() => table.clear());

test('refuses missing, forged, wrong-group and other-tool tokens on every route', async () => {
  for (const route of ROUTES) {
    const [m, p] = route.split(' ');
    assert.equal((await call(m, p, undefined, null)).status, 401, route);
    assert.equal((await call(m, p, undefined, forgedToken({ clientId: CLIENT_ID, group: 'lukes_chamber' }))).status, 401, route);
    assert.equal((await call(m, p, undefined, accessToken({ clientId: CLIENT_ID, group: 'family_budget' }))).status, 403, route);
    assert.equal((await call(m, p, undefined, accessToken({ clientId: 'other-tool', group: 'lukes_chamber' }))).status, 401, route);
  }
});

test('readings since a time, oldest first, across UTC days and pages', async () => {
  for (let i = 0; i < 8; i++) stored(ago((30 - i) * HOUR), { rh_pct: 80 + i, temp_c: 24 });
  stored(ago(80 * HOUR), { rh_pct: 1 });
  const { status, body } = await call('GET', `/readings?since=${Date.now() - 48 * HOUR}`);
  assert.equal(status, 200);
  assert.deepEqual(body.fields, ['rh_pct', 'temp_c']);
  assert.deepEqual(body.rows.map((r) => r[1]), [80, 81, 82, 83, 84, 85, 86, 87], 'every page of every day, in order');
  assert.ok(body.rows.every((r, i, a) => i === 0 || r[0] > a[i - 1][0]));

  const later = await call('GET', `/readings?since=${body.rows[5][0]}`);
  assert.deepEqual(later.body.rows.map((r) => r[1]), [86, 87], 'after, not at, since: polling never repeats a row');
});

test('readings: at most three days back, two hours by default, and only the asked-for fields', async () => {
  stored(ago(80 * HOUR), { rh_pct: 1 });
  stored(ago(70 * HOUR), { rh_pct: 2 });
  stored(ago(3 * HOUR), { rh_pct: 3 });
  stored(ago(HOUR), { rh_pct: 4, uptime_s: 9 });
  assert.deepEqual((await call('GET', '/readings?since=0')).body.rows.map((r) => r[1]), [2, 3, 4]);
  assert.deepEqual((await call('GET', '/readings')).body.rows.map((r) => r[1]), [4]);
  const narrow = await call('GET', `/readings?since=${Date.now() - 4 * HOUR}&fields=rh_pct`);
  assert.deepEqual(narrow.body.fields, ['rh_pct']);
  assert.deepEqual(narrow.body.rows.map((r) => r.length), [2, 2]);
  const missing = await call('GET', `/readings?since=${Date.now() - 4 * HOUR}&fields=rh_pct,uptime_s`);
  assert.deepEqual(missing.body.rows[0], [missing.body.rows[0][0], 3, null], 'a field a row lacks is null');
});

test('readings as CSV: every field, the last day at most', async () => {
  stored(ago(30 * HOUR), { rh_pct: 1 });
  stored(new Date(Date.UTC(2030, 0, 1)), { rh_pct: 9 }); // in the future: not yet
  stored(ago(2 * HOUR), { rh_pct: 85.5, temp_c: 24 });
  stored(ago(HOUR), { rh_pct: 86 });
  const res = await handler({
    routeKey: 'GET /readings.csv', headers: { authorization: `Bearer ${memberToken()}` },
    queryStringParameters: { since: '0' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/csv');
  const lines = res.body.trim().split('\n');
  assert.equal(lines[0], 'iso_time,epoch_s,rh_pct,temp_c');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z,\d+,85\.5,24$/);
  assert.match(lines[2], /,86,$/, 'a missing field is empty');
});

test('settings: nothing saved yet, then what the board reports', async () => {
  let { body } = await call('GET', '/settings');
  assert.equal(body.desired, null);
  assert.equal(body.active, null);
  assert.ok(body.spec.some((s) => s.key === 'mist_burst_s' && s.max === 60));
  clock.now = new Date();
  await post(`${reading()}\n${cfgRecord({ version: 2 })}`);
  ({ body } = await call('GET', '/settings'));
  assert.equal(body.active.version, 2);
  assert.equal(body.activeAt, clock.now.toISOString());
});

test('saving settings merges onto what the board runs, and versions above anything it has seen', async () => {
  clock.now = new Date();
  await post(`${reading()}\n${cfgRecord({ version: 5, rejected: 7 })}`);
  const { status, body } = await call('PUT', '/settings', { values: { mist_burst_s: '30' } });
  assert.equal(status, 200);
  assert.equal(body.desired.version, 8, 'above the refused 7, or the board would ignore it');
  assert.deepEqual(body.desired.values, { rh_on: 87, rh_off: 92, mist_burst_s: 30, mist_settle_s: 100 });
  const again = await call('PUT', '/settings', { values: { rh_on: 86, rest_fan_mist: true } });
  assert.equal(again.body.desired.version, 9);
  assert.equal(again.body.desired.values.mist_burst_s, 30, 'keeps the earlier edit');
  assert.equal(again.body.desired.values.rest_fan_mist, 1);
  const log = table.dump().filter(([k]) => k.startsWith('SETLOG|') && k.includes('#saved#')).map(([, v]) => v);
  assert.deepEqual(log.map((v) => v.version), [8, 9]);
  assert.ok(log.every((v) => v.by), 'says who saved it');
});

test('refuses settings out of range, unknown, or that break a rule as a whole', async () => {
  await call('PUT', '/settings', { values: { rh_on: 85, rh_off: 92 } });
  for (const [values, error] of [
    [{ mist_burst_s: 61 }, /Mist burst/],
    [{ mist_burst_s: 'lots' }, /not a number/],
    [{ heater_power: 1 }, /Unknown setting/],
    [{ rh_off: 84 }, /above start-misting/], // fine alone; not against the saved rh_on 85
    [{ heater_hold_s: 300, heater_interval_s: 120 }, /Heater hold/],
  ]) {
    const r = await call('PUT', '/settings', { values });
    assert.equal(r.status, 400, JSON.stringify(values));
    assert.match(r.body.error, error);
  }
  assert.equal((await call('PUT', '/settings', {})).status, 400);
  assert.equal((await call('GET', '/settings')).body.desired.version, 1, 'nothing saved');
});

test('a save that lost a race is refused, not merged blindly', async () => {
  await call('PUT', '/settings', { values: { rh_on: 85 } });
  // Two saves read the same version; only the first to write wins
  const [a, b] = await Promise.all([
    call('PUT', '/settings', { values: { rh_on: 86 } }),
    call('PUT', '/settings', { values: { mist_burst_s: 30 } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await call('GET', '/settings')).body.desired.version, 2);
});

test('refill: counted up, logged with who said so, and shown with the settings', async () => {
  assert.equal((await call('GET', '/settings')).body.refill, null);
  const r = await call('POST', '/refill');
  assert.equal(r.status, 200);
  assert.equal(r.body.refill.id, 1);
  assert.ok(r.body.refill.by && r.body.refill.at);
  assert.equal((await call('POST', '/refill')).body.refill.id, 2);
  assert.equal((await call('GET', '/settings')).body.refill.id, 2);
  const log = table.dump().filter(([k]) => k.startsWith('SETLOG|')).map(([, v]) => [v.event, v.version]);
  assert.deepEqual(log, [['refilled', 1], ['refilled', 2]]);
});

test('API Gateway routes match the ones the handler serves', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  const ingest = await readFile(new URL('../infra/ingest.tf', import.meta.url), 'utf8');
  assert.match(ingest, /route_key = "POST \/ingest"/);
  assert.doesNotMatch(ingest, /authorization_type/, 'the board has no token; the Lambda checks its key');
});
