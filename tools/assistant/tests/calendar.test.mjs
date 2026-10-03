import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { makeCalendar } from '../api/calendar.mjs';
import { makeGoogleAuth } from '../api/google.mjs';

const CALS = { luke: 'luke.doty@gmail.com', shared: 'abc@group.calendar.google.com' };
function fakeGoogle(responses = {}) {
  const requests = [];
  const fetch = async (url, o = {}) => {
    const u = new URL(url);
    requests.push({ method: o.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: o.body ? JSON.parse(o.body) : undefined, auth: o.headers?.authorization });
    const r = responses[`${o.method || 'GET'} ${u.pathname}`] ?? {};
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body ?? {} };
  };
  return { fetch, requests };
}
const cal = (g) => makeCalendar({ accessToken: async () => 'tok', calendars: CALS, timeZone: 'America/New_York', fetch: g.fetch });

test('list_events sends a bounded, time-zone-correct query and returns compact events', async () => {
  const g = fakeGoogle({ 'GET /calendar/v3/calendars/luke.doty%40gmail.com/events': { body: { items: [
    { id: 'e1', summary: 'Dentist', start: { dateTime: '2026-10-05T14:00:00-04:00' }, end: { dateTime: '2026-10-05T15:00:00-04:00' }, extendedProperties: { private: { by: 'assistant' } } },
    { id: 'e2', status: 'cancelled' },
    { id: 'e3', summary: 'Trip', start: { date: '2026-10-09' }, end: { date: '2026-10-12' } },
  ] } } });
  const events = await cal(g).listEvents({ calendar: 'luke', start: '2026-10-05', end: '2026-10-12', max_results: 500 });
  const q = g.requests[0].query;
  assert.equal(q.timeMin, '2026-10-05T00:00:00-04:00');
  assert.equal(q.timeMax, '2026-10-12T00:00:00-04:00');
  assert.equal(q.singleEvents, 'true');
  assert.equal(q.maxResults, '50', 'capped at 50');
  assert.equal(g.requests[0].auth, 'Bearer tok');
  assert.deepEqual(events.map((e) => [e.id, e.all_day, e.created_by_assistant]), [['e1', false, true], ['e3', true, false]]);
});

test('only configured calendars can be used', async () => {
  const g = fakeGoogle();
  await assert.rejects(cal(g).listEvents({ calendar: 'work', start: '2026-10-05', end: '2026-10-06' }), /Unknown calendar "work"/);
  await assert.rejects(cal(g).listEvents({ calendar: '__proto__', start: '2026-10-05', end: '2026-10-06' }), /Unknown calendar/);
  assert.equal(g.requests.length, 0);
});

test('create_event: timed events carry the time zone; all-day ends become exclusive; events are tagged', async () => {
  const g = fakeGoogle();
  await cal(g).createEvent({ calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', end: '2026-10-05T15:00', location: 'Main St' });
  await cal(g).createEvent({ calendar: 'shared', title: 'Beach', start: '2026-10-09', end: '2026-10-11', all_day: true });
  await cal(g).createEvent({ calendar: 'shared', title: 'Holiday', start: '2026-10-12', all_day: true });
  const [timed, trip, oneDay] = g.requests.map((r) => r.body);
  assert.equal(g.requests[0].path, '/calendar/v3/calendars/abc%40group.calendar.google.com/events');
  assert.deepEqual(timed.start, { dateTime: '2026-10-05T14:00:00-04:00', timeZone: 'America/New_York' });
  assert.equal(timed.location, 'Main St');
  assert.deepEqual([trip.start, trip.end], [{ date: '2026-10-09' }, { date: '2026-10-12' }]);
  assert.deepEqual([oneDay.start, oneDay.end], [{ date: '2026-10-12' }, { date: '2026-10-13' }]);
  assert.deepEqual(timed.extendedProperties, { private: { source: 'home_host', by: 'assistant' } });
});

test('update_event sends only what changed; delete_event encodes the id', async () => {
  const g = fakeGoogle();
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'abc_20261005', title: 'Dentist (moved)' });
  await cal(g).deleteEvent({ calendar: 'luke', event_id: 'a/b' });
  assert.deepEqual(g.requests[0].body, { summary: 'Dentist (moved)' });
  assert.equal(g.requests[0].method, 'PATCH');
  assert.equal(g.requests[1].path, '/calendar/v3/calendars/luke.doty%40gmail.com/events/a%2Fb');
});

test('Google errors surface with their message', async () => {
  const g = fakeGoogle({ 'GET /calendar/v3/calendars/luke.doty%40gmail.com/events': { status: 404, body: { error: { message: 'Not Found' } } } });
  await assert.rejects(cal(g).listEvents({ calendar: 'luke', start: '2026-10-05', end: '2026-10-06' }), /404: Not Found/);
});

test('Google sign-in: signs a JWT with the key and caches the token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'bot@x.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let loads = 0, posts = 0, assertion;
  const auth = makeGoogleAuth({
    loadKey: async () => { loads++; return key; },
    fetch: async (url, o) => { posts++; assertion = new URLSearchParams(o.body).get('assertion'); return { ok: true, json: async () => ({ access_token: 'T', expires_in: 3600 }) }; },
  });
  assert.equal(await auth(), 'T');
  assert.equal(await auth(), 'T');
  assert.deepEqual([loads, posts], [1, 1]);
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, key.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar');
});

test('Google sign-in: a rotated key is reloaded from SSM once, then works', async () => {
  const mk = (email) => ({ client_email: email, token_uri: 'https://oauth2.googleapis.com/token', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const oldKey = mk('old@x.iam.gserviceaccount.com'), newKey = mk('new@x.iam.gserviceaccount.com');
  const keys = [oldKey, newKey];
  const auth = makeGoogleAuth({
    loadKey: async () => keys.shift(),
    fetch: async (url, o) => {
      const iss = JSON.parse(Buffer.from(new URLSearchParams(o.body).get('assertion').split('.')[1], 'base64url').toString()).iss;
      return iss === newKey.client_email
        ? { ok: true, json: async () => ({ access_token: 'NEW', expires_in: 3600 }) }
        : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    },
  });
  assert.equal(await auth(), 'NEW');

  // A key that's still refused after the reload is an error, not a loop
  let loads = 0;
  const stuck = makeGoogleAuth({ loadKey: async () => { loads++; return oldKey; }, fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }) });
  await assert.rejects(stuck(), /invalid_grant/);
  assert.equal(loads, 2);
});
