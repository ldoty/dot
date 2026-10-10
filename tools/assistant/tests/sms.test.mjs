import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createSmsWorker, toTexts, QUIET_HOURS } from '../api/sms.mjs';
import { systemPrompt } from '../api/agent.mjs';
import { deps, NOW, store, table } from './helpers/deps.mjs';
import { text, toolUse } from './helpers/fake-claude.mjs';

const PHONE = '+18645550123';
const USER = 'luke-sub';
beforeEach(() => table.clear());

function worker(script, extra = {}) {
  const d = deps(script);
  const sent = [];
  const run = createSmsWorker({ ...d.deps, text: async (to, body) => { sent.push({ to, body }); }, ...extra });
  return { ...d, sent, run: (t, more = {}) => run({ userId: USER, username: USER, phone: PHONE, text: t, messageSid: 'SM1', ...more }) };
}
const smsConversations = async () => (await store.listConversations(USER)).filter((c) => c.channel === 'sms');

test('a text runs one turn as that person and the reply is texted back', async () => {
  const seen = [];
  const { run, sent, claude } = worker([text('Nothing on Saturday.')], {
    forUser: async (claims, channel) => { seen.push({ claims, channel }); return { person: { name: 'Luke' } }; },
  });
  await run('Anything Saturday?');
  assert.deepEqual(sent, [{ to: PHONE, body: 'Nothing on Saturday.' }]);
  assert.deepEqual(seen, [{ claims: { sub: USER, username: USER }, channel: 'sms' }], 'Dot acts as the texter, and audits say sms');
  assert.equal(claude.calls[0].params.system[0].text, systemPrompt({ name: 'Luke', calendars: true, channel: 'sms' }));
  const [conv] = await smsConversations();
  assert.equal(conv.title, 'Anything Saturday?');
});

test('the texting prompt asks for plain text and no links; the web prompt is unchanged', () => {
  const sms = systemPrompt({ name: 'Luke', channel: 'sms' });
  assert.match(sms, /texting you/);
  assert.match(sms, /no Markdown/);
  assert.match(sms, /never write a web address/);
  assert.doesNotMatch(systemPrompt({ name: 'Luke' }), /texting/);
  assert.equal(systemPrompt({ name: 'Luke' }), systemPrompt({ name: 'Luke', channel: 'web' }));
});

test('texts carry on the current texting conversation', async () => {
  const { run, claude } = worker([text('Nothing.'), text('Sunday is free too.')]);
  await run('Anything Saturday?');
  await run('And Sunday?');
  assert.equal((await smsConversations()).length, 1);
  assert.deepEqual(claude.calls[1].params.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('after a quiet spell, or with only web conversations, a text starts a new conversation', async () => {
  const old = new Date(NOW.getTime() - (QUIET_HOURS * 3600e3 + 60e3));
  await store.createConversation(USER, { id: 'old-sms', title: 'Old', channel: 'sms', now: old });
  await store.createConversation(USER, { id: 'web-now', title: 'Web', channel: 'web', now: NOW });
  const { run, claude } = worker([text('Hi.')]);
  await run('Hello');
  assert.equal(claude.calls[0].params.messages.length, 1, 'no earlier history');
  assert.equal((await smsConversations()).length, 2);
});

test('tools run by text the same as on the web', async () => {
  const { run, sent, calendar } = worker([
    toolUse('create_event', { calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', end: '2026-10-05T15:00' }),
    text('Added Dentist to shared, Mon Oct 5, 2–3 PM.'),
  ]);
  await run('Dentist Monday at 2 on the family calendar');
  assert.equal(calendar.calls[0].name, 'createEvent');
  assert.deepEqual(sent.map((s) => s.body), ['Added Dentist to shared, Mon Oct 5, 2–3 PM.']);
});

test('a failed turn still texts something useful back', async () => {
  const { run, sent } = worker([() => { throw new Anthropic.RateLimitError(429, {}, 'slow down', new Headers()); }]);
  await run('Hi');
  assert.deepEqual(sent.map((s) => s.body), ['Too many requests right now. Wait a moment and try again.']);
});

test('a refusal says Dot declined', async () => {
  const { run, sent } = worker([{ content: [], stop_reason: 'refusal' }]);
  await run('Hi');
  assert.deepEqual(sent.map((s) => s.body), ['Dot declined to answer that one.']);
});

test('malformed events never run a turn or send a text', async () => {
  const { run, sent, claude } = worker([]);
  await run('Hi', { phone: '+447700900123' });
  await run('   ');
  await run('Hi', { userId: undefined });
  assert.deepEqual([sent.length, claude.calls.length], [0, 0]);
});

test('replies become plain texts with no links', () => {
  assert.deepEqual(toTexts('**Saturday:**\n### Plans\n* Soccer at 9\n* [Budget](https://budget.dot-y.co/)'), ['Saturday:\nPlans\n- Soccer at 9\n- Budget']);
  assert.deepEqual(toTexts('Edit it at budget.dot-y.co, or see https://example.com/x.'), ['Edit it at the family site, or see (link left out).']);
  assert.deepEqual(toTexts('Email contact@dot-y.co for help.'), ['Email contact@dot-y.co for help.'], 'an email address isn’t a link');
});

test('a long reply is split at a break, up to three texts', () => {
  const para = 'A sentence that goes on for a while. '.repeat(30).trim(); // ~1,100 characters
  const texts = toTexts([para, para, para].join('\n\n'));
  assert.equal(texts.length, 3);
  assert.ok(texts.every((t) => t.length <= 1500));
  assert.equal(texts[0], para);
  const huge = toTexts('word '.repeat(2000));
  assert.equal(huge.length, 3);
  assert.ok(huge.every((t) => t.length <= 1500));
  assert.match(huge[2], /The rest is on the Dot page\.\)$/);
});

// dot-y.co/privacy: message content is kept up to 12 months
test('texted conversations expire a year after their last message; web ones never do', async () => {
  const { run } = worker([text('Hi.')]);
  await run('Hello');
  const year = Math.floor(NOW.getTime() / 1000) + 365 * 86400;
  const sms = table.dump().map(([, item]) => item);
  assert.equal(sms.length, 3, 'the conversation and two messages');
  assert.ok(sms.every((i) => i.expiresAt === year), JSON.stringify(sms.map((i) => [i.sk, i.expiresAt])));
  assert.equal((await smsConversations())[0].expiresAt, undefined, 'not shown to the page');

  table.clear();
  const web = deps([text('Hi.')]);
  const { runTurn } = await import('../api/agent.mjs');
  await runTurn({ ...web.deps, userId: USER, text: 'Hello' });
  assert.ok(table.dump().every(([, item]) => item.expiresAt === undefined));
});
