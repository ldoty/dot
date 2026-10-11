// The real chamber handlers on an in-memory table: the page's API (as API Gateway calls it, with
// a token) and the board's ingest endpoint (with a device key), sharing one table.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const CLIENT_ID = 'chamber-client';
export const DEVICE_KEY = 'test-device-key-0123456789abcdef';
Object.assign(process.env, { TABLE: 'family-chamber', GROUP: 'lukes_chamber', ISSUER, CLIENT_ID });
// Small pages, so reading a day's partition has to follow LastEvaluatedKey
export const table = fakeTable({ pageSize: 3 });

const api = await import('../../api/api.mjs');
const { createIngest } = await import('../../api/ingest.mjs');
export const { handler, ROUTES } = api;
export const memberToken = () => accessToken({ clientId: CLIENT_ID, group: 'lukes_chamber' });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);

// The board's side. `clock.now` is what the ingest Lambda thinks the time is.
export const clock = { now: new Date('2026-10-12T14:00:00Z') };
const ingest = createIngest({ deviceKey: async () => DEVICE_KEY, now: () => clock.now, timeZone: 'America/New_York' });
export async function post(body, key = DEVICE_KEY) {
  const res = await ingest({
    routeKey: 'POST /ingest',
    headers: key === null ? {} : { 'x-chamber-key': key },
    body,
  });
  return { status: res.statusCode, body: res.body };
}

// A reading the way build 13 sends it (field subset)
export const reading = (over = {}) => {
  const f = { temp_c: 24.3, rh_pct: 85.5, mist_state: 0, mist_block: 0, atomizer_on: 0, mist_bursts: 4, uptime_s: 600, fw_build: 13, ...over };
  return `chamber ${Object.entries(f).map(([k, v]) => `${k}=${Number.isInteger(v) ? `${v}i` : v}`).join(',')}`;
};
export const cfgRecord = (over = {}) => {
  const f = { version: 0, rejected: 0, fw_build: 13, rh_on: 87, rh_off: 92, mist_burst_s: 20, mist_settle_s: 100, ...over };
  return `chamber_cfg ${Object.entries(f).map(([k, v]) => `${k}=${v}i`).join(',')}`;
};
