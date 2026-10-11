import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_KEY, call, cfgRecord, clock, post, reading, table } from './helpers/chamber.mjs';
import { parseLine, secondsSinceMidnight } from '../api/ingest.mjs';

beforeEach(() => { table.clear(); clock.now = new Date('2026-10-12T14:00:00Z'); });

test('refuses a missing or wrong device key, and stores nothing', async () => {
  assert.equal((await post(reading(), null)).status, 401);
  assert.equal((await post(reading(), 'wrong')).status, 401);
  assert.equal((await post(reading(), DEVICE_KEY.slice(0, -1))).status, 401);
  assert.equal((await post(reading(), '')).status, 401);
  assert.deepEqual(table.dump(), []);
});

test('stores a reading under its UTC day, stamped on receipt, and keeps the latest', async () => {
  const r = await post(reading({ rh_pct: 86.25 }));
  assert.equal(r.status, 200);
  const row = table.get('R#2026-10-12', '2026-10-12T14:00:00.000Z');
  assert.equal(row.rh_pct, 86.25);
  assert.equal(row.fw_build, 13, 'integers lose their i');
  assert.equal(row.expires, Date.parse('2027-10-12T14:00:00Z') / 1000, 'kept a year');
  assert.equal(table.get('STATE', 'LATEST').fields.rh_pct, 86.25);
});

test('replies with local time of day, through daylight saving time', async () => {
  // 14:00Z on 12 October is 10:00 EDT; 17:00Z on 15 January is 12:00 EST
  assert.match((await post(reading())).body, /^time=36000\n$/);
  clock.now = new Date('2026-01-15T17:00:00Z');
  assert.match((await post(reading())).body, /^time=43200\n$/);
  assert.equal(secondsSinceMidnight(new Date('2026-10-12T04:00:00Z'), 'America/New_York'), 0, 'midnight is 0, not 24h');
});

test('hands the board saved settings in the cfg line it parses', async () => {
  await call('PUT', '/settings', { values: { mist_burst_s: 25 } });
  const { body } = await post(reading());
  const [time, cfg, end] = body.split('\n');
  assert.match(time, /^time=\d+$/);
  assert.match(cfg, /^cfg=1;/);
  assert.ok(cfg.includes(';mist_burst_s=25'));
  assert.equal(end, '', 'ends in a newline, which readTimeSync() relies on');
  // readTimeSync() reads headers + body into 768 bytes; leave room for API Gateway's headers.
  // Every setting at its widest value is the longest line the board can be sent.
  const { spec } = (await call('GET', '/settings')).body;
  const widest = Object.fromEntries(spec.map((s) => [s.key, s.kind === 'bool' ? 1 : s.max - (s.step < 1 ? s.step : 0)]));
  assert.equal((await call('PUT', '/settings', { values: widest })).status, 200);
  assert.ok(Buffer.byteLength((await post(reading())).body) < 400);
});

test('records what the board runs, and logs applied, defaults and refused versions', async () => {
  const tick = () => { clock.now = new Date(+clock.now + 10e3); };
  await post(`${reading()}\n${cfgRecord()}`);
  assert.equal(table.get('STATE', 'ACTIVE').fields.version, 0);
  tick(); await post(`${reading()}\n${cfgRecord({ version: 3 })}`);
  tick(); await post(`${reading()}\n${cfgRecord({ version: 3 })}`); // unchanged: no new log row
  tick(); await post(`${reading()}\n${cfgRecord({ version: 3, rejected: 4 })}`);
  const log = table.dump().filter(([k]) => k.startsWith('SETLOG|')).map(([, v]) => [v.event, v.version]);
  assert.deepEqual(log, [['board defaults', 0], ['board applied', 3], ['board rejected', 4]]);
  assert.deepEqual(Object.keys(table.dump().find(([k]) => k.startsWith('SETLOG|'))[1].values).sort(),
    ['mist_burst_s', 'mist_settle_s', 'rh_off', 'rh_on'], 'logs settings, not version bookkeeping');
});

test('refuses bad payloads without storing anything', async () => {
  for (const body of ['', 'chamber', 'chamber rh_pct', 'chamber rh_pct=abc', 'Chamber rh=1', 'chamber pk=1,rh_pct=2', 'x'.repeat(3000)]) {
    const r = await post(body);
    assert.ok(r.status === 400 || r.status === 413, `${body.slice(0, 30)} -> ${r.status}`);
  }
  assert.deepEqual(table.dump(), []);
});

test('a failed sensor reading (nan) is a missing value, not a rejected reading', () => {
  assert.deepEqual(parseLine('chamber temp_c=nan,rh_pct=50.5,uptime_s=10i').fields, { rh_pct: 50.5, uptime_s: 10 });
});

test('the firmware sends what this endpoint expects', async () => {
  // Keep the firmware's request and this parser in step: same header, same path
  const ino = await readFile(new URL('../firmware/chamber_telemetry/chamber_telemetry.ino', import.meta.url), 'utf8');
  assert.match(ino, /POST \/ingest HTTP\/1\.1/);
});
