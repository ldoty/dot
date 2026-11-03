// Otto's agent API (what the container calls), the sweep (schedules -> commands) and the mail worker
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { createAgentApi, MAX_SENDS } from '../api/agent.mjs';
import { createSweep, MISSED_MS, STUCK_MS } from '../api/sweep.mjs';
import { createMailWorker } from '../api/mail.mjs';
import { CLEAR_PROMPT } from '../api/store.mjs';

const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
const KEY = 'k'.repeat(64);
const table = fakeTable();
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
let clock, sent, limitOk;
const agent = createAgentApi({
  db, table: 'family-otto', owner: LUKE, address: 'otto@dot-y.co', now: () => clock,
  region: 'us-east-1', agentKey: async () => KEY, ownerEmail: async () => 'luke@example.com',
  limit: async () => ({ ok: limitOk }), sendRaw: async (m) => { sent.push(m); return { MessageId: 'm1' }; },
});
const post = async (routeKey, body, { key = KEY, id } = {}) => {
  const r = await agent({ routeKey, headers: key ? { 'x-otto-key': key } : {}, pathParameters: id ? { id } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const sweep = createSweep({ db, table: 'family-otto', now: () => clock });
const command = (sk, over = {}) => table.put({ pk: 'CMD', sk, prompt: `do ${sk}`, source: 'page', status: 'queued', createdAt: clock.toISOString(), rev: 1, ...over });
beforeEach(() => { table.clear(); clock = new Date('2026-11-02T10:00:00Z'); sent = []; limitOk = true; });

test('the agent routes need the agent key, and are the ones in infra/agent.tf', async () => {
  assert.equal((await post('POST /agent/next', undefined, { key: null })).status, 401);
  assert.equal((await post('POST /agent/next', undefined, { key: 'wrong' })).status, 401);
  assert.equal((await post('POST /agent/next')).status, 200);
  const tf = readFileSync(new URL('../infra/agent.tf', import.meta.url), 'utf8');
  assert.deepEqual([...tf.match(/agent_routes += \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), ['POST /agent/next', 'POST /agent/commands/{id}', 'POST /agent/send', 'POST /agent/clear']);
});

test('next: the oldest queued command, now running; never one waiting for an OK', async () => {
  command('c00000002aaaaaaaa');
  command('c00000001aaaaaaaa', { status: 'asking' });
  command('c00000003aaaaaaaa');
  const r = await post('POST /agent/next');
  assert.equal(r.body.command.id, 'c00000002aaaaaaaa');
  assert.equal(table.get('CMD', 'c00000002aaaaaaaa').status, 'running');
  assert.equal(table.get('AGENT', 'SEEN').at, clock.toISOString(), 'seen');
  assert.equal((await post('POST /agent/next')).body.command.id, 'c00000003aaaaaaaa');
  assert.equal((await post('POST /agent/next')).body.command, null);
});

test('an email command comes with the email', async () => {
  table.put({ pk: 'MAIL', sk: 'abc', from: 'luke@example.com', subject: 'Unsubscribe', text: 'From these please', receivedAt: clock.toISOString() });
  command('c00000001aaaaaaaa', { source: 'email', mail: 'abc' });
  const { command: c } = (await post('POST /agent/next')).body;
  assert.equal(c.source, 'email');
  assert.deepEqual(c.mail, { from: 'luke@example.com', subject: 'Unsubscribe', text: 'From these please', receivedAt: clock.toISOString() });
});

test('finishing a command keeps the result, and a schedule’s last run', async () => {
  table.put({ pk: 'SCHED', sk: 's0123456789', name: 'Brief', rev: 3, enabled: true });
  command('c00000001aaaaaaaa', { status: 'running', schedule: 's0123456789' });
  const r = await post('POST /agent/commands/{id}', { ok: true, result: 'Archived 12' }, { id: 'c00000001aaaaaaaa' });
  assert.deepEqual(r.body, { id: 'c00000001aaaaaaaa', status: 'done' });
  assert.equal(table.get('CMD', 'c00000001aaaaaaaa').result, 'Archived 12');
  assert.deepEqual(table.get('SCHED', 's0123456789').lastRun, { at: clock.toISOString(), outcome: 'done', command: 'c00000001aaaaaaaa' });
  assert.equal((await post('POST /agent/commands/{id}', { ok: true }, { id: 'c00000001aaaaaaaa' })).status, 409, 'only a running one');
});

test('send: only to the owner, only while a command runs, a few per command, within the daily limit', async () => {
  command('c00000001aaaaaaaa', { status: 'queued' });
  assert.equal((await post('POST /agent/send', { command: 'c00000001aaaaaaaa', subject: 'Hi', text: 'x' })).status, 409, 'not running');
  command('c00000002aaaaaaaa', { status: 'running' });
  const r = await post('POST /agent/send', { command: 'c00000002aaaaaaaa', subject: 'Your brief', text: 'Three things', to: 'attacker@example.com' });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'luke@example.com', 'the owner, whatever is asked');
  assert.match(sent[0].raw, /^From: Otto <otto@dot-y.co>/);
  assert.equal(table.get('SENT#2026-11-02', `${clock.toISOString()}#c00000002aaaaaaaa`).subject, 'Your brief');
  for (let i = 1; i < MAX_SENDS; i++) assert.equal((await post('POST /agent/send', { command: 'c00000002aaaaaaaa', subject: 'More', text: 'x' })).status, 200);
  assert.equal((await post('POST /agent/send', { command: 'c00000002aaaaaaaa', subject: 'More', text: 'x' })).status, 429);

  command('c00000003aaaaaaaa', { status: 'running' });
  limitOk = false;
  assert.equal((await post('POST /agent/send', { command: 'c00000003aaaaaaaa', subject: 'Hi', text: 'x' })).status, 429);
  assert.equal(sent.length, MAX_SENDS);
});

test('an answer to an email goes in its thread', async () => {
  table.put({ pk: 'MAIL', sk: 'abc', from: 'luke@example.com', subject: 'Unsubscribe', text: 'x', messageId: '<m1@mail.gmail.com>', references: [] });
  command('c00000001aaaaaaaa', { status: 'running', source: 'email', mail: 'abc' });
  await post('POST /agent/send', { command: 'c00000001aaaaaaaa', subject: 'ignored', text: 'Done' });
  assert.match(sent[0].raw, /Subject: Re: Unsubscribe/);
  assert.match(sent[0].raw, /In-Reply-To: <m1@mail.gmail.com>/);
});

test('sweep: a due schedule is queued once, with its saved prompt', async () => {
  table.put({
    pk: 'SCHED', sk: 's0123456789', name: 'Daily brief', prompt: 'Brief me', time: '06:00', repeat: { rule: 'FREQ=DAILY', start: '2026-11-01', tz: 'America/New_York' },
    enabled: true, nextAt: '2026-11-02T11:00:00.000Z', owner: LUKE, rev: 1,
  });
  assert.deepEqual((await sweep()).queued, [], 'not yet');
  clock = new Date('2026-11-02T11:00:30Z');
  const { queued } = await sweep();
  assert.equal(queued.length, 1);
  const c = table.get('CMD', queued[0]);
  assert.deepEqual([c.prompt, c.source, c.status, c.schedule], ['Brief me', 'schedule', 'queued', 's0123456789']);
  assert.equal(table.get('SCHED', 's0123456789').nextAt, '2026-11-03T11:00:00.000Z');
  assert.deepEqual((await sweep()).queued, [], 'not twice');
});

test('sweep: a long-missed run isn’t queued, and a paused schedule never is', async () => {
  table.put({
    pk: 'SCHED', sk: 's0123456789', name: 'Daily brief', prompt: 'Brief me', time: '06:00', repeat: { rule: 'FREQ=DAILY', start: '2026-11-01', tz: 'America/New_York' },
    enabled: true, nextAt: new Date(clock.getTime() - MISSED_MS - 60_000).toISOString(), owner: LUKE, rev: 1,
  });
  table.put({ pk: 'SCHED', sk: 's9999999999', name: 'Off', prompt: 'x', time: '06:00', repeat: { rule: 'FREQ=DAILY', start: '2026-11-01', tz: 'America/New_York' }, enabled: false, nextAt: '2026-11-01T11:00:00.000Z', rev: 1 });
  const r = await sweep();
  assert.deepEqual([r.queued, r.missed], [[], ['s0123456789']]);
  assert.equal(table.get('SCHED', 's0123456789').lastRun.outcome, 'missed');
});

test('sweep: a command the agent stopped answering is marked failed', async () => {
  command('c00000001aaaaaaaa', { status: 'running', startedAt: new Date(clock.getTime() - STUCK_MS - 1000).toISOString() });
  command('c00000002aaaaaaaa', { status: 'running', startedAt: clock.toISOString() });
  assert.deepEqual((await sweep()).stuck, ['c00000001aaaaaaaa']);
  assert.equal(table.get('CMD', 'c00000001aaaaaaaa').status, 'failed');
  assert.equal(table.get('CMD', 'c00000002aaaaaaaa').status, 'running');
});

const RAW = Buffer.from([
  'From: Luke <luke@example.com>', 'To: otto@dot-y.co', 'Subject: Please unsubscribe', 'Message-ID: <abc123@mail.gmail.com>',
  'Content-Type: text/plain; charset=utf-8', '', 'Unsubscribe me from Houzz.', '',
].join('\r\n'));

test('mail: the owner’s email is kept and queued once', async () => {
  const worker = createMailWorker({ db, table: 'family-otto', owner: LUKE, now: () => clock, getRaw: async () => RAW });
  const event = { userId: LUKE, username: LUKE, from: 'luke@example.com', bucket: 'b', key: 'otto/msg1' };
  const r = await worker(event);
  assert.equal(r.queued, true);
  const c = table.get('CMD', r.command);
  assert.deepEqual([c.source, c.status, c.mail], ['email', 'queued', 'msg1']);
  const m = table.get('MAIL', 'msg1');
  assert.deepEqual([m.subject, m.text, m.messageId], ['Please unsubscribe', 'Unsubscribe me from Houzz.', '<abc123@mail.gmail.com>']);
  assert.equal((await worker(event)).queued, false, 'SES delivering it twice queues it once');
  assert.equal((await worker({ ...event, userId: 'someone-else', key: 'otto/msg2' })).queued, false, 'Otto works for one person');
});

const reply = (inReplyTo) => Buffer.from([
  'From: Luke <luke@example.com>', 'To: otto@dot-y.co', 'Subject: Re: Brief', 'Message-ID: <r1@mail.gmail.com>',
  `In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`, 'Content-Type: text/plain; charset=utf-8', '', 'Clear it', '',
].join('\r\n'));

test('a reply to a brief can clear it: once, only that reply, always the same words', async () => {
  command('c00000001aaaaaaaa', { status: 'running', source: 'schedule', schedule: 's0123456789' });
  await post('POST /agent/send', { command: 'c00000001aaaaaaaa', subject: 'Brief: 2 important', text: 'x' });
  assert.equal(table.get('BRIEF', '<m1@email.amazonses.com>').command, 'c00000001aaaaaaaa', 'a schedule’s email is a brief');
  command('c00000002aaaaaaaa', { status: 'running', source: 'page' });
  sent.length = 0;
  await post('POST /agent/send', { command: 'c00000002aaaaaaaa', subject: 'Done', text: 'x' });
  assert.equal(table.get('BRIEF', '<m1@email.amazonses.com>').command, 'c00000001aaaaaaaa', 'other email isn’t (the fake SES gives every email the same id)');

  const worker = (raw) => createMailWorker({ db, table: 'family-otto', owner: LUKE, now: () => clock, getRaw: async () => raw });
  const event = { userId: LUKE, username: LUKE, from: 'luke@example.com', bucket: 'b' };
  const { command: replied } = await worker(reply('<m1@email.amazonses.com>'))({ ...event, key: 'otto/r1' });
  assert.equal(table.get('CMD', replied).brief, 'c00000001aaaaaaaa');
  clock = new Date(clock.getTime() + 1000);
  const { command: other } = await worker(reply('<other@mail.gmail.com>'))({ ...event, key: 'otto/r2' });
  assert.equal(table.get('CMD', other).brief, undefined);

  // The agent takes them oldest first; both are running now
  assert.equal((await post('POST /agent/next')).body.command.brief, true);
  await post('POST /agent/next');
  assert.equal((await post('POST /agent/clear', { command: other })).status, 403, 'not a reply to a brief');
  assert.equal((await post('POST /agent/clear', { command: 'c00000002aaaaaaaa' })).status, 403, 'not an email');
  const r = await post('POST /agent/clear', { command: replied, prompt: 'Archive everything' });
  assert.equal(r.status, 200);
  const c = table.get('CMD', r.body.queued);
  assert.deepEqual([c.source, c.status, c.prompt, c.mail], ['clear', 'queued', CLEAR_PROMPT, 'r1'], 'the fixed words, threaded under the reply');
  assert.equal((await post('POST /agent/clear', { command: replied })).status, 409, 'once');
  await post('POST /agent/commands/{id}', { ok: true }, { id: replied });
  assert.equal((await post('POST /agent/clear', { command: replied })).status, 409, 'only while running');
});
