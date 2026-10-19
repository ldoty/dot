import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { makeCalendar } from '../api/google-calendar.mjs';
import { makeGoogleAuth } from '../api/google.mjs';

const CALS = { luke: 'luke.doty@gmail.com', shared: 'abc@group.calendar.google.com' };
function fakeGoogle(responses = {}) {
  const requests = [];
  const fetch = async (url, o = {}) => {
    const u = new URL(url);
    requests.push({ method: o.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), types: u.searchParams.getAll('eventTypes'), body: o.body ? JSON.parse(o.body) : undefined, auth: o.headers?.authorization });
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
    { id: 'e4', summary: 'Flight to Denver', eventType: 'fromGmail', start: { dateTime: '2026-10-09T08:00:00-04:00' }, end: { dateTime: '2026-10-09T10:30:00-06:00' } },
  ] } } });
  const events = await cal(g).listEvents({ calendar: 'luke', start: '2026-10-05', end: '2026-10-12', max_results: 500 });
  const q = g.requests[0].query;
  assert.equal(q.timeMin, '2026-10-05T00:00:00-04:00');
  assert.equal(q.timeMax, '2026-10-12T00:00:00-04:00');
  assert.equal(q.singleEvents, 'true');
  assert.equal(q.maxResults, '50', 'capped at 50');
  assert.equal(g.requests[0].auth, 'Bearer tok');
  assert.ok(g.requests[0].types.includes('fromGmail'), 'Gmail-created events (flights) are asked for');
  assert.ok(g.requests[0].types.includes('default'));
  assert.deepEqual(events.map((e) => [e.id, e.all_day, e.created_by_assistant]), [['e1', false, true], ['e3', true, false], ['e4', false, false]]);
  assert.equal(events[2].type, 'fromGmail');
  assert.equal(events[0].type, undefined);
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

// Amber can read Luke's calendar; Dot's service account could change it, so the module must refuse
test('a read-only calendar can be read but never changed, before Google is asked', async () => {
  const g = fakeGoogle({ 'GET /calendar/v3/calendars/luke.doty%40gmail.com': { body: { summary: 'Luke Doty', timeZone: 'America/New_York' } } });
  const c = makeCalendar({ accessToken: async () => 'tok', calendars: CALS, readOnly: ['luke'], timeZone: 'America/New_York', fetch: g.fetch });
  await c.listEvents({ calendar: 'luke', start: '2026-10-05', end: '2026-10-06' });
  assert.equal(g.requests.length, 1, 'reading works');
  await assert.rejects(c.createEvent({ calendar: 'luke', title: 'X', start: '2026-10-05T14:00' }), /read-only for you/);
  await assert.rejects(c.updateEvent({ calendar: 'luke', event_id: 'e1', title: 'Y' }), /read-only for you/);
  await assert.rejects(c.deleteEvent({ calendar: 'luke', event_id: 'e1' }), /read-only for you/);
  assert.equal(g.requests.length, 1, 'no write ever reached Google');
  await c.createEvent({ calendar: 'shared', title: 'X', start: '2026-10-05T14:00' });
  assert.equal(g.requests.at(-1).method, 'POST', 'other calendars still change');
  const listed = await c.listCalendars();
  assert.equal(listed.find((l) => l.calendar === 'luke').read_only, true);
  assert.equal(listed.find((l) => l.calendar === 'shared').read_only, undefined);
});

test('colors: set by name on create and update, cleared with "default", shown by name', async () => {
  const g = fakeGoogle({ 'PATCH /calendar/v3/calendars/luke.doty%40gmail.com/events/e1': { body: { id: 'e1', summary: 'Dentist', colorId: '11', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } } } });
  await cal(g).createEvent({ calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', color: 'basil' });
  await cal(g).createEvent({ calendar: 'shared', title: 'Plain', start: '2026-10-05T14:00', color: 'default' });
  const shown = await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', color: 'tomato' });
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', color: 'default' });
  assert.equal(g.requests[0].body.colorId, '10');
  assert.equal('colorId' in g.requests[1].body, false, 'a new event in the default color sends none');
  assert.deepEqual(g.requests[2].body, { colorId: '11' });
  assert.deepEqual(g.requests[3].body, { colorId: null }, 'null clears the event’s color in a PATCH');
  assert.equal(shown.color, 'tomato');
  await assert.rejects(cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', color: 'toString' }), /Unknown color/);
  assert.equal(g.requests.length, 4);
});

test('people are noted on the event (description + private property), never sent as attendees', async () => {
  const g = fakeGoogle();
  await cal(g).createEvent({
    calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', description: 'Bring the insurance card',
    people: [{ name: ' Dr.  Patel ', email: 'Front.Desk@SmileClinic.example' }, { email: 'amy@example.com' }, { name: 'Amber' }],
  });
  const body = g.requests[0].body;
  assert.equal(body.attendees, undefined, 'a service account can’t invite on Gmail calendars');
  assert.equal(body.description, 'Bring the insurance card\n\nPeople:\n- Dr. Patel <front.desk@smileclinic.example>\n- amy@example.com\n- Amber');
  assert.deepEqual(JSON.parse(body.extendedProperties.private.people), [
    { name: 'Dr. Patel', email: 'front.desk@smileclinic.example' }, { email: 'amy@example.com' }, { name: 'Amber' },
  ]);
  assert.equal(body.extendedProperties.private.by, 'assistant');
  for (const bad of [[{ email: 'not an email' }], [{}], Array(11).fill({ name: 'X' }), [{ email: 'a@b.c>, evil@x.y' }]]) {
    await assert.rejects(cal(g).createEvent({ calendar: 'shared', title: 'X', start: '2026-10-05T14:00', people: bad }));
  }
  assert.equal(g.requests.length, 1, 'bad people never reach Google');
});

test('events read back their own notes and people separately', async () => {
  const people = [{ name: 'Dr. Patel', email: 'desk@clinic.example' }];
  const g = fakeGoogle({ 'GET /calendar/v3/calendars/luke.doty%40gmail.com/events': { body: { items: [
    { id: 'e1', summary: 'Dentist', start: { date: '2026-10-05' }, end: { date: '2026-10-06' }, description: 'Card\n\nPeople:\n- Dr. Patel <desk@clinic.example>', extendedProperties: { private: { people: JSON.stringify(people) } } },
    { id: 'e2', summary: 'Edited by hand', start: { date: '2026-10-05' }, end: { date: '2026-10-06' }, description: 'People:\n- Dr. P (call first)', extendedProperties: { private: { people: JSON.stringify(people) } } },
    { id: 'e3', summary: 'Junk property', start: { date: '2026-10-05' }, end: { date: '2026-10-06' }, extendedProperties: { private: { people: '{nope' } } },
  ] } } });
  const [a, b, c] = await cal(g).listEvents({ calendar: 'luke', start: '2026-10-05', end: '2026-10-06' });
  assert.deepEqual([a.description, a.people], ['Card', people]);
  assert.equal(b.description, 'People:\n- Dr. P (call first)', 'a hand-edited description is shown as it is');
  assert.equal(c.people, undefined);
});

test('update_event: changing people or notes rewrites the description from the event as it is', async () => {
  const path = '/calendar/v3/calendars/luke.doty%40gmail.com/events/e1';
  const current = { id: 'e1', summary: 'Dentist', description: 'Card\n\nPeople:\n- Dr. Patel', extendedProperties: { private: { by: 'assistant', people: '[{"name":"Dr. Patel"}]' } } };
  const g = fakeGoogle({ [`GET ${path}`]: { body: current } });
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', people: [{ name: 'Dr. Patel' }, { email: 'desk@clinic.example' }] });
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', description: 'Bring the card' });
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', people: [] });
  await cal(g).updateEvent({ calendar: 'luke', event_id: 'e1', title: 'Dentist!' });
  const patches = g.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);
  assert.deepEqual(patches[0], { description: 'Card\n\nPeople:\n- Dr. Patel\n- desk@clinic.example', extendedProperties: { private: { people: '[{"name":"Dr. Patel"},{"email":"desk@clinic.example"}]' } } });
  assert.deepEqual(patches[1], { description: 'Bring the card\n\nPeople:\n- Dr. Patel' }, 'new notes keep the people');
  assert.deepEqual(patches[2], { description: 'Card', extendedProperties: { private: { people: '[]' } } }, '[] clears them');
  assert.deepEqual(patches[3], { summary: 'Dentist!' }, 'other changes don’t touch the description');
  assert.equal(g.requests.filter((r) => r.method === 'GET').length, 3);
});
