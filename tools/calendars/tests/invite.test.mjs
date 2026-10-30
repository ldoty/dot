import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AMBER, KID, call, dotToken, google, seed, sent, token, clock } from './helpers/calendars.mjs';
import { icsInvite } from '../api/invite.mjs';
import { INVITES_PER_DAY as LIMIT } from '../api/api.mjs';

beforeEach(seed);
const people = [{ name: 'Dr. Smith', email: 'office@smithdental.example' }, { name: 'Grandma' }];
const make = async (t = token()) => (await call('POST', '/events', { calendar: 'kids', title: 'Dentist, Mia', start: '2026-11-02T09:00', end: '2026-11-02T10:00', location: '12 Main St', people }, t)).body;
/** iCalendar folds lines at 75 octets; read them whole */
const unfold = (ics) => ics.replace(/\r\n /g, '');
/** A sent message's parts: headers and the decoded calendar */
function parts(raw) {
  const ics = Buffer.from(/Content-Type: text\/calendar[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw)[1].replace(/\s/g, ''), 'base64').toString();
  return { ics: unfold(ics), header: (n) => new RegExp(`^${n}: (.*)$`, 'm').exec(raw)?.[1] };
}

test('from the page: the people noted on the event with an email get an invitation, from the person', async () => {
  const e = await make();
  const r = await call('POST', `/events/kids/${e.id}/invite`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sent, ['office@smithdental.example'], 'Grandma has no email: not invited');
  assert.equal(sent.length, 1);
  const { ics, header } = parts(sent[0].raw);
  assert.equal(header('From'), 'Luke via dot-y.co <invites@dot-y.co>');
  assert.equal(header('Reply-To'), 'Luke <luke@x.test>');
  assert.equal(header('Auto-Submitted'), 'auto-generated');
  assert.match(ics, /^METHOD:REQUEST\r$/m);
  assert.match(ics, new RegExp(`^UID:${e.id}@google.com\\r$`, 'm'), 'tied to the Google event');
  assert.match(ics, /^DTSTART:20261102T140000Z\r$/m, '9:00 in New York is 14:00 UTC');
  assert.ok(ics.includes('SUMMARY:Dentist\\, Mia\r\n'));
  assert.match(ics, /^ORGANIZER;CN="Luke":mailto:luke@x\.test\r$/m);
  assert.match(ics, /^ATTENDEE;CN="Dr\. Smith";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:office@smithdental\.example\r$/m);
});

test('from Dot: asks first, and only that person’s OK for those people and that event sends it', async () => {
  const e = await make(dotToken());
  const ask = await call('POST', `/events/kids/${e.id}/invite`, {}, dotToken());
  assert.equal(ask.status, 202);
  assert.match(ask.body.prompt, /Dentist, Mia.*Dr\. Smith \(office@smithdental\.example\), from you\?/);
  assert.equal(sent.length, 0, 'nothing sent before their OK');
  assert.equal((await call('POST', `/events/kids/${e.id}/invite?confirm_id=${ask.body.confirm_id}`, {}, dotToken(AMBER))).status, 403, 'Amber can only see kids');
  const ok = await call('POST', `/events/kids/${e.id}/invite?confirm_id=${ask.body.confirm_id}`, {}, dotToken());
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
  assert.equal((await call('POST', `/events/kids/${e.id}/invite?confirm_id=${ask.body.confirm_id}`, {}, dotToken())).status, 400, 'used once');
});

test('only from calendars they may change; only people noted on the event; a daily limit', async () => {
  const e = await make();
  assert.equal((await call('POST', `/events/kids/${e.id}/invite`, {}, token(AMBER))).status, 403);
  assert.equal((await call('POST', `/events/kids/${e.id}/invite`, {}, token(KID))).status, 403);
  assert.equal((await call('POST', `/events/kids/${e.id}/invite`, { emails: ['stranger@example.com'] })).status, 400);
  assert.equal(sent.length, 0);
  // Already near today's limit
  for (let i = 0; i < LIMIT; i++) {
    const r = await call('POST', `/events/kids/${e.id}/invite`, { emails: ['office@smithdental.example'] });
    assert.equal(r.status, 200, `invite ${i + 1}`);
  }
  assert.equal((await call('POST', `/events/kids/${e.id}/invite`, {})).status, 429);
  clock.now = new Date(clock.now.getTime() + 86_400_000);
  assert.equal((await call('POST', `/events/kids/${e.id}/invite`, {})).status, 200, 'a new day');
});

test('the .ics: all-day dates, folded long lines, escaped text', () => {
  const folded = icsInvite({
    event: { ical_uid: 'u1', sequence: 2, starts: { date: '2026-11-02' }, ends: { date: '2026-11-03' }, title: 'Trip; with, commas', full_description: `${'a'.repeat(120)}\nline two` },
    organizer: { name: 'Luke "L" Doty', email: 'l@x.test' }, attendees: [{ email: 'g@x.test' }], now: new Date('2026-10-30T00:00:00Z'),
  });
  assert.ok(folded.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'no line over 75 octets');
  const ics = unfold(folded);
  assert.match(ics, /^DTSTART;VALUE=DATE:20261102\r$/m);
  assert.match(ics, /^SEQUENCE:2\r$/m);
  assert.ok(ics.includes('SUMMARY:Trip\\; with\\, commas\r\n'));
  assert.ok(ics.includes(`DESCRIPTION:${'a'.repeat(120)}\\nline two\r\n`));
  assert.match(ics, /^ORGANIZER;CN="Luke L Doty":mailto:l@x\.test\r$/m);
  assert.match(ics, /^ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:g@x\.test\r$/m);
});

test('infra/api.tf routes include the invite route', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  assert.match(tf, /"POST \/events\/\{calendar\}\/\{eventId\}\/invite"/);
  assert.match(tf, /"ses:FromAddress" = local\.invite_address/);
});
