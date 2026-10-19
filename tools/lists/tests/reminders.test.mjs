import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AMBER, KID, LUKE, call, clock, newList, outbox, reset, sweep, table, token } from './helpers/lists.mjs';
import { smsBody } from '../api/sweep.mjs';

const at = (iso) => ({ at: iso });
const remindRows = () => table.dump().filter(([k]) => k.startsWith('REMIND#')).map(([, v]) => v.sk);
const minute = (iso) => { clock.now = new Date(iso); return sweep(); };
beforeEach(reset);

test('a reminder goes out when due, by text by default, once', async () => {
  const l = await newList('Errands');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Call the dentist', remind: at('2026-10-20T13:00:00Z') });
  assert.deepEqual(remindRows(), [`2026-10-20T13:00:00.000Z#${l.id}#i00001`]);
  await minute('2026-10-20T12:59:00Z');
  assert.deepEqual(outbox.texts, [], 'not yet');
  await minute('2026-10-20T13:00:30Z');
  assert.deepEqual(outbox.texts, [{ phone: '+18645550100', body: 'Dot-y reminder: Call the dentist (Errands). Reply done, or snooze for a while.' }]);
  assert.doesNotMatch(outbox.texts[0].body, /https?:|www\.|\.co\b/, 'texts never carry links (the campaign is registered without them)');
  await minute('2026-10-20T13:01:30Z');
  assert.equal(outbox.texts.length, 1, 'never twice');
  assert.deepEqual(remindRows(), []);
  const item = (await call('GET', `/lists/${l.id}`)).body.items[0];
  assert.equal(item.remind.sentAt, '2026-10-20T13:00:30.000Z');
  assert.deepEqual((await call('GET', '/reminders/recent')).body.map((r) => [r.text, r.list, r.channel]), [['Call the dentist', 'Errands', 'sms']]);
  assert.deepEqual((await call('GET', '/reminders/recent', undefined, token(AMBER))).body, [], 'only your own');
});

test('a missed minute is caught up by the next sweep', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Bins out', remind: at('2026-10-19T23:30:00Z') });
  await minute('2026-10-20T00:05:00Z'); // the sweep was down across midnight UTC
  assert.equal(outbox.texts.length, 1);
});

test('ticked off, deleted or moved: nothing is sent at the old time', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'A', remind: at('2026-10-19T15:00:00Z') });
  await call('PUT', `/lists/${l.id}/items/i00002`, { text: 'B', remind: at('2026-10-19T15:00:00Z') });
  await call('PUT', `/lists/${l.id}/items/i00003`, { text: 'C', remind: at('2026-10-19T15:00:00Z') });
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'A', done: true, remind: at('2026-10-19T15:00:00Z'), rev: 1 });
  await call('DELETE', `/lists/${l.id}/items/i00002`);
  await call('PUT', `/lists/${l.id}/items/i00003`, { text: 'C', remind: at('2026-10-19T16:00:00Z'), rev: 1 });
  await minute('2026-10-19T15:00:30Z');
  assert.deepEqual(outbox.texts, []);
  await minute('2026-10-19T16:00:30Z');
  assert.deepEqual(outbox.texts.map((t) => t.body.split(' (')[0]), ['Dot-y reminder: C']);
});

test('editing an item keeps a sent reminder sent; a new time sends again', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Pills', remind: at('2026-10-19T15:00:00Z') });
  await minute('2026-10-19T15:00:30Z');
  const sent = (await call('GET', `/lists/${l.id}`)).body.items[0];
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Pills, with food', remind: at('2026-10-19T15:00:00Z'), rev: sent.rev });
  await minute('2026-10-19T15:01:30Z');
  assert.equal(outbox.texts.length, 1, 'same time: already sent');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Pills, with food', remind: at('2026-10-20T15:00:00Z'), rev: sent.rev + 1 });
  await minute('2026-10-20T15:00:30Z');
  assert.equal(outbox.texts.length, 2, 'snoozed to tomorrow');
});

test('the reminder goes to whoever set it, by their preference or the reminder’s own channel', async () => {
  const l = await newList('Groceries');
  await call('PUT', `/lists/${l.id}`, { name: 'Groceries', layout: 'checklist', columns: l.columns, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Coffee', remind: at('2026-10-19T15:00:00Z') }, token(AMBER));
  await call('PUT', `/lists/${l.id}/items/i00002`, { text: 'Bread', remind: { at: '2026-10-19T15:00:00Z', channel: 'email' } });
  await minute('2026-10-19T15:00:30Z');
  // Amber has no verified phone, so her text default falls back to email
  assert.deepEqual(outbox.emails.map((e) => [e.to, e.subject]).sort(), [['amber@x.test', 'Reminder: Coffee'], ['luke@x.test', 'Reminder: Bread']]);
  assert.match(outbox.emails[0].text, /Reply to tell Dot “done” or “snooze an hour”/);
  assert.deepEqual(outbox.texts, []);
});

test('a failed send is recorded, not retried', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'X', remind: at('2026-10-19T15:00:00Z') });
  outbox.fail = 'Twilio 400: blocked';
  await minute('2026-10-19T15:00:30Z');
  outbox.fail = null;
  await minute('2026-10-19T15:01:30Z');
  assert.deepEqual(outbox.texts, []);
  const [sent] = table.dump().filter(([k]) => k.startsWith('SENT#')).map(([, v]) => v);
  assert.equal(sent.error, 'Twilio 400: blocked');
});

test('no verified phone or email: recorded as not sent', async () => {
  const l = await newList('Chores', KID);
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Dishes', remind: at('2026-10-19T15:00:00Z') }, token(KID));
  const [r] = await minute('2026-10-19T15:00:30Z');
  assert.deepEqual([r.channel, r.error], [null, 'no verified phone or email']);
});

test('deleting a list drops its pending reminders', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'X', remind: at('2026-10-19T15:00:00Z') });
  await call('DELETE', `/lists/${l.id}`);
  assert.deepEqual(remindRows(), []);
});

test('the text stays short', () => {
  assert.ok(smsBody('y'.repeat(500), 'A list').length < 200);
  assert.equal(LUKE.length, 36);
});

test('two sweeps at once still send a reminder only once', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Once', remind: at('2026-10-19T15:00:00Z') });
  clock.now = new Date('2026-10-19T15:00:30Z');
  await Promise.all([sweep(), sweep()]);
  assert.equal(outbox.texts.length, 1);
});

test('a leftover index row for a done or moved item sends nothing, and is cleared', async () => {
  const l = await newList();
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Done already', done: true, remind: at('2026-10-19T15:00:00Z') });
  await call('PUT', `/lists/${l.id}/items/i00002`, { text: 'Moved', remind: at('2026-10-19T18:00:00Z') });
  // as if deleting the old index rows had failed
  table.put({ pk: 'REMIND#2026-10-19', sk: `2026-10-19T15:00:00.000Z#${l.id}#i00001`, listId: l.id, itemId: 'i00001' });
  table.put({ pk: 'REMIND#2026-10-19', sk: `2026-10-19T15:00:00.000Z#${l.id}#i00002`, listId: l.id, itemId: 'i00002' });
  await minute('2026-10-19T15:00:30Z');
  assert.deepEqual(outbox.texts, []);
  assert.deepEqual(remindRows(), [`2026-10-19T18:00:00.000Z#${l.id}#i00002`], 'only the real one is left');
});
