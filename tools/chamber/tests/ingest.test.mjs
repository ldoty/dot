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
  assert.match((await post(reading())).body, /^time=36000\n/);
  clock.now = new Date('2026-01-15T17:00:00Z');
  assert.match((await post(reading())).body, /^time=43200\n/);
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
  // Keep the firmware's request and this endpoint in step: path, key header, HTTPS
  const ino = await readFile(new URL('../firmware/chamber_telemetry/chamber_telemetry.ino', import.meta.url), 'utf8');
  assert.match(ino, /POST \/ingest HTTP\/1\.1/);
  assert.match(ino, /x-chamber-key: /);
  assert.match(ino, /WiFiSSLClient client;/, 'API Gateway only speaks HTTPS');
});

test('the firmware never stops misting on its water estimate', async () => {
  // Builds 11-15 latched misting off once the mL estimate reached the reservoir's size; the
  // estimate ran so high it stopped a chamber with plenty of water. The atomizer's float covers dry.
  const ino = await readFile(new URL('../firmware/chamber_telemetry/chamber_telemetry.ino', import.meta.url), 'utf8');
  assert.doesNotMatch(ino, /RESERVOIR_ML|MIST_BLOCK_BUDGET/);
  assert.doesNotMatch(ino, /refill=|refill_id/, 'no refill handshake left to wait on');
  assert.match(ino, /MIST_BLOCK_NO_RESPONSE/, 'the dry-run check stays');
});

test('the board range-checks every setting with the same bounds the API does', async () => {
  // A bound the API allows but the board refuses rejects the whole version, so they must match.
  const ino = await readFile(new URL('../firmware/chamber_telemetry/chamber_telemetry.ino', import.meta.url), 'utf8');
  const { spec } = (await call('GET', '/settings')).body;
  for (const s of spec.filter((x) => x.kind === 'num')) {
    const m = ino.match(new RegExp(`"${s.key}"\\)+\\s*\\{[^}]*IN\\(v, (\\d+), (\\d+)\\)`));
    assert.ok(m, `firmware checks ${s.key}`);
    assert.deepEqual([+m[1], +m[2]], [s.min, s.max], s.key);
  }
  assert.equal(spec.find((x) => x.key === 'fae_period_s').max, 86400, 'vents can be up to a day apart');
});

test('the firmware rebuilds WiFi after failed posts, not only when WiFi says it is down', async () => {
  // 2026-10-27: status() said connected for six hours while every post failed
  const ino = await readFile(new URL('../firmware/chamber_telemetry/chamber_telemetry.ino', import.meta.url), 'utf8');
  const publish = ino.slice(ino.indexOf('void publish()'), ino.indexOf('void setup()'));
  assert.match(publish, /if \(!client\.connect\([^}]*notePostFailed\(\);[^}]*\}/, 'a failed connect counts');
  assert.match(publish, /bool replied = readTimeSync\(client\);[\s\S]*?postFailStreak = 0;[\s\S]*?notePostFailed\(\);/,
    'a reply clears the streak, no reply counts');
  const burstCheck = publish.indexOf('mistBurstCanAbsorb(MIST_BURST_MAX_MS)');
  assert.ok(burstCheck > 0 && burstCheck < publish.indexOf('notePostFailed'), 'never resets the modem during a mist burst');
  const note = ino.slice(ino.indexOf('void notePostFailed()'), ino.indexOf('void tachISR()'));
  assert.match(note, /WiFi\.disconnect\(\);/);
  assert.match(note, /lastWifiAttempt = /, 'and makes the reconnect due');
});
