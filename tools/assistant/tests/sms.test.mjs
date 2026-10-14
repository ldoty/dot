import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createSmsWorker, toTexts, QUIET_HOURS } from '../api/sms.mjs';
import { fetchMedia, deleteMedia } from '../api/twilio.mjs';
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
  await run('   ', { media: [] });
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

// Photos (MMS): fake Twilio media, served from a map of url -> { type, bytes } (or a status)
const SID = 'AC' + '1'.repeat(32);
const mediaUrl = (n) => `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM${'9'.repeat(32)}/Media/ME${String(n).repeat(32)}`;
function twilioMedia(files) {
  const fetched = [], deleted = [];
  return {
    fetched, deleted,
    fetchMedia: async (url, maxBytes) => {
      fetched.push(url);
      const f = files[url];
      if (!f || f.status) throw new Error(`Twilio media ${f?.status ?? 404}`);
      if (f.bytes.length > maxBytes) throw new Error('too large');
      return f;
    },
    deleteMedia: async (url) => { deleted.push(url); },
  };
}
const JPEG = Buffer.from('fake jpeg bytes');
const userBlocks = (call) => call.params.messages[0].content;

test('a photo is shown to Claude for that turn, deleted from Twilio, and not kept', async () => {
  const m = twilioMedia({ [mediaUrl(1)]: { type: 'image/jpeg', bytes: JPEG } });
  const { run, sent, claude } = worker([text('That’s a dentist card for Oct 20 at 3 PM.'), text('Added.')], m);
  await run('', { media: [{ url: mediaUrl(1), type: 'image/jpeg' }] });
  const blocks = userBlocks(claude.calls[0]);
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image'], 'the time, then the photo; no empty text block');
  assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') });
  assert.deepEqual(m.deleted, [mediaUrl(1)]);
  assert.deepEqual(sent.map((s) => s.body), ['That’s a dentist card for Oct 20 at 3 PM.']);

  const [conv] = await smsConversations();
  assert.equal(conv.title, 'Photo');
  const stored = table.dump().map(([, item]) => item.content).filter(Boolean).join('');
  assert.ok(!stored.includes(JPEG.toString('base64')), 'the photo isn’t stored');
  assert.match(stored, /\[Photo, not kept\]/);

  await run('Add it to my calendar');
  assert.deepEqual(claude.calls[1].params.messages[0].content.map((b) => b.type), ['text', 'text'], 'a later turn sees the note, not the photo');
});

test('a photo with words: Claude gets both; tool steps in that turn still see the photo', async () => {
  const m = twilioMedia({ [mediaUrl(1)]: { type: 'image/png', bytes: JPEG } });
  const { run, claude } = worker([
    toolUse('create_event', { calendar: 'shared', title: 'Soccer', start: '2026-10-10T09:00' }),
    text('Added Soccer.'),
  ], m);
  await run('Add this', { media: [{ url: mediaUrl(1), type: 'image/png' }] });
  assert.deepEqual(userBlocks(claude.calls[0]).slice(1).map((b) => b.text ?? b.type), ['image', 'Add this']);
  assert.equal(userBlocks(claude.calls[1])[1].type, 'image');
});

test('photos that can’t be opened are deleted anyway, and Dot is told what didn’t come through', async () => {
  const m = twilioMedia({
    [mediaUrl(1)]: { status: 500 },
    [mediaUrl(2)]: { type: 'image/jpeg', bytes: Buffer.alloc(3_750_001) },
    [mediaUrl(3)]: { type: 'text/html', bytes: JPEG },
  });
  const { run, claude, sent } = worker([text('I couldn’t open those.')], m);
  await run('What’s this?', { media: [1, 2, 3].map((n) => ({ url: mediaUrl(n), type: 'image/jpeg' })), skipped: 1 });
  assert.deepEqual(m.deleted, [1, 2, 3].map(mediaUrl));
  assert.deepEqual(userBlocks(claude.calls[0]).slice(1).map((b) => b.text), ['What’s this?\n\n[4 attachments couldn’t be opened]']);
  assert.equal(sent.length, 1);
});

test('only a photo, and it can’t be opened: a short reply, no turn', async () => {
  const m = twilioMedia({});
  const { run, claude, sent } = worker([], m);
  await run('', { media: [{ url: mediaUrl(1), type: 'image/jpeg' }] });
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(sent.map((s) => s.body), ['Dot couldn’t open that photo. Try sending it again.']);
  assert.deepEqual(m.deleted, [mediaUrl(1)]);
});

test('a failed delete is logged, not fatal', async () => {
  const m = { ...twilioMedia({ [mediaUrl(1)]: { type: 'image/jpeg', bytes: JPEG } }), deleteMedia: async () => { throw new Error('Twilio 503'); } };
  const { run, sent } = worker([text('Got it.')], m);
  await run('', { media: [{ url: mediaUrl(1), type: 'image/jpeg' }] });
  assert.deepEqual(sent.map((s) => s.body), ['Got it.']);
});

test('Twilio media: signs in only to this account’s media, and refuses oversized downloads', async () => {
  const cfg = { accountSid: SID, apiKeySid: 'SK' + '2'.repeat(32), apiKeySecret: 'secret' };
  const calls = [];
  const fetchFn = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', auth: o.headers?.authorization });
    const size = url.includes('ME3') ? 10 : 4;
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg; charset=binary', 'content-length': String(size) }), arrayBuffer: async () => new ArrayBuffer(size) };
  };
  const got = await fetchMedia(cfg, mediaUrl(1), { maxBytes: 5, fetchFn });
  assert.deepEqual([got.type, got.bytes.length], ['image/jpeg', 4]);
  assert.equal(calls[0].auth, `Basic ${Buffer.from(`${cfg.apiKeySid}:secret`).toString('base64')}`);
  await assert.rejects(fetchMedia(cfg, mediaUrl(3), { maxBytes: 5, fetchFn }), /too large/);
  for (const bad of ['https://evil.example.com/x', mediaUrl(1).replace(SID, 'AC' + '3'.repeat(32)), `${mediaUrl(1)}/../../x`]) {
    await assert.rejects(fetchMedia(cfg, bad, { maxBytes: 5, fetchFn }), /not this account/);
    await assert.rejects(deleteMedia(cfg, bad, fetchFn), /not this account/);
  }
  await deleteMedia(cfg, mediaUrl(1), fetchFn);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', mediaUrl(1)], ['GET', mediaUrl(3)], ['DELETE', `${mediaUrl(1)}.json`]]);
});
