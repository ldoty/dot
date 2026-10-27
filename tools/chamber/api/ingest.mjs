// The chamber board's telemetry endpoint: POST /ingest, called every ~10 s by the Arduino
// (firmware/chamber_telemetry). The board can't sign in, so this route has no authorizer;
// instead every request must carry the device key in x-chamber-key, checked here against the
// SecureString at DEVICE_KEY_PARAM (set by hand, never in tofu state). Its role can only read
// that parameter, read the desired settings and write readings, so a leaked key can add fake
// readings but can't read anything back or change what the chamber runs.
//
// Body: InfluxDB line protocol, one record per line, no timestamps (we stamp on receipt; the
// board's clock resets with every power cycle):
//   chamber temp_c=24.3,rh_pct=57.74,...,fw_build=13i
//   chamber_cfg version=13i,rejected=0i,rh_on=87.00,...      (only now and then)
// Reply (text/plain, which the firmware's readTimeSync() parses):
//   time=<seconds since local midnight>\n
//   refill=<how many refills the page has counted>\n            (build 15 resets its water count when it rises)
//   cfg=<version>;key=value;...\n                              (once settings have been saved)
// Seconds since local midnight, not an epoch, so the board never handles time zones or DST.
//
// Rows: R#<UTC day> / <ISO time>   one reading (expires after a year)
//       STATE / LATEST                 the newest reading, for alerts and Dot later
//       STATE / ACTIVE                 the board's last chamber_cfg: what it really runs
//       STATE / REFILL                 refills counted on the page (api/api.mjs writes it)
//       SETLOG / <ISO time>#<event>#<v> settings history ("board applied", "board rejected")
import { createHash, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { cfgLine, settingsOf } from './settings.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAX_BODY = 2048; // a reading plus a chamber_cfg line is about 1.1 KB
const MAX_FIELDS = 60;
const KEEP_DAYS = 365;
const RESERVED = new Set(['pk', 'sk', 'expires', 't']); // row keys, and the API's time column

const text = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/plain' }, body });

/** One line-protocol record -> { measurement, fields }. Integers end in "i"; non-finite values are dropped. */
export function parseLine(line) {
  const m = /^([a-z_][a-z0-9_]*) (\S+)$/.exec(line.trim());
  if (!m) throw new Error('expected "measurement field=value,..."');
  const fields = {};
  for (const pair of m[2].split(',')) {
    const f = /^([a-z][a-z0-9_]{0,39})=(-?[0-9.]+(?:e-?[0-9]+)?i?|nan|inf|-inf)$/i.exec(pair);
    if (!f) throw new Error(`malformed field ${pair.slice(0, 40)}`);
    if (RESERVED.has(f[1])) throw new Error(`reserved field ${f[1]}`);
    const v = Number(f[2].endsWith('i') ? f[2].slice(0, -1) : f[2]);
    if (Number.isFinite(v)) fields[f[1]] = v; // a NaN from a failed sensor is a missing value, and DynamoDB refuses NaN
  }
  if (Object.keys(fields).length > MAX_FIELDS) throw new Error('too many fields');
  return { measurement: m[1], fields };
}

/** Seconds since midnight in timeZone at `at`. */
export function secondsSinceMidnight(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
}

// Compare digests so the check takes the same time whatever the key's length or contents
function keyMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** deps: deviceKey() -> the key, now() -> Date, timeZone */
export function createIngest({ deviceKey, now = () => new Date(), timeZone = 'America/New_York' }) {
  return async (event) => {
    if (event.routeKey !== 'POST /ingest') return text(404, 'no route\n');
    if (!keyMatches(event.headers?.['x-chamber-key'], await deviceKey())) {
      console.warn('refused: bad device key');
      return text(401, 'unauthorized\n');
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
    if (raw.length > MAX_BODY) return text(413, 'too large\n');

    let reading;
    const extra = [];
    try {
      const lines = raw.split('\n').filter((l) => l.trim());
      if (!lines.length) throw new Error('empty body');
      reading = parseLine(lines[0]);
      for (const l of lines.slice(1)) extra.push(parseLine(l));
    } catch (e) {
      return text(400, `bad payload: ${e.message}\n`);
    }

    const at = now();
    const iso = at.toISOString();
    const { TABLE } = process.env;
    const cfg = extra.find((r) => r.measurement === 'chamber_cfg');
    // All at once: the board only listens for the reply for a few hundred milliseconds
    const state = async (sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'STATE', sk } }))).Item;
    const [desired, refill] = await Promise.all([
      state('DESIRED'),
      state('REFILL'),
      db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `R#${iso.slice(0, 10)}`, sk: iso, ...reading.fields, expires: Math.floor(at / 1000) + KEEP_DAYS * 86400 },
      })),
      db.send(new PutCommand({ TableName: TABLE, Item: { pk: 'STATE', sk: 'LATEST', at: iso, fields: reading.fields } })),
      cfg && boardReported(TABLE, cfg.fields, iso),
    ]);
    return text(200, `time=${secondsSinceMidnight(at, timeZone)}\nrefill=${refill?.id ?? 0}\n${cfgLine(desired)}`);
  };
}

// The board says what it runs. Log when that changes: a new version applied (or firmware
// defaults after a reboot), or a version it refused.
async function boardReported(TABLE, fields, iso) {
  const prev = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'STATE', sk: 'ACTIVE' } }))).Item?.fields ?? {};
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: 'STATE', sk: 'ACTIVE', at: iso, fields } }));
  const log = (event, version) => db.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'SETLOG', sk: `${iso}#${event}#${version}`, event, version, values: settingsOf(fields) },
  }));
  const ver = fields.version ?? 0, rej = fields.rejected ?? 0;
  if (ver !== prev.version) await log(ver > 0 ? 'board applied' : 'board defaults', ver);
  if (rej && rej !== prev.rejected) await log('board rejected', rej);
}

// The key is read once per container; rotating it means updating the parameter and then
// letting the Lambda recycle (or redeploying).
let cachedKey;
const ssm = new SSMClient({});
async function deviceKeyFromSsm() {
  cachedKey ??= ssm.send(new GetParameterCommand({ Name: process.env.DEVICE_KEY_PARAM, WithDecryption: true }))
    .then((r) => r.Parameter.Value)
    .catch((e) => { cachedKey = undefined; throw e; });
  return cachedKey;
}

export const handler = createIngest({ deviceKey: deviceKeyFromSsm, timeZone: process.env.LOCAL_TZ });
