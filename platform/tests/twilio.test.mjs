import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPhone, sendText, twilioConfig, twilioSignature, validTwilioSignature } from '../api/twilio.mjs';

const URL_ = 'https://abc123.execute-api.us-east-1.amazonaws.com/twilio';
const PARAMS = { From: '+18645550123', Body: 'Hi Dot', AccountSid: 'AC' + '0'.repeat(32), MessageSid: 'SM1' };
const CONFIG = { accountSid: 'AC' + 'a'.repeat(32), authToken: 'secret', messagingServiceSid: 'MG' + 'b'.repeat(32) };

test('the signature is Twilio’s: HMAC-SHA1 over the URL and the sorted params', () => {
  // Computed independently (Python hmac) from Twilio's description of the scheme
  assert.equal(twilioSignature('test-token', URL_, PARAMS), 'XXHtrV0iTwXlHkBS8iFmICZJnUc=');
  assert.equal(twilioSignature('test-token', URL_, Object.fromEntries(Object.entries(PARAMS).reverse())), 'XXHtrV0iTwXlHkBS8iFmICZJnUc=', 'param order doesn’t matter');
});

test('a signature checks out only for the same token, URL and params', () => {
  const sig = twilioSignature('test-token', URL_, PARAMS);
  assert.equal(validTwilioSignature('test-token', URL_, PARAMS, sig), true);
  assert.equal(validTwilioSignature('other-token', URL_, PARAMS, sig), false);
  assert.equal(validTwilioSignature('test-token', URL_ + 'x', PARAMS, sig), false);
  assert.equal(validTwilioSignature('test-token', URL_, { ...PARAMS, From: '+18645550000' }, sig), false);
  assert.equal(validTwilioSignature('test-token', URL_, PARAMS, undefined), false);
  assert.equal(validTwilioSignature('test-token', URL_, PARAMS, 'short'), false);
  assert.equal(validTwilioSignature('', URL_, PARAMS, twilioSignature('', URL_, PARAMS)), false, 'no token, no trust');
});

test('a text goes through the Messaging Service with basic auth', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ sid: 'SM123' }) }; };
  assert.equal(await sendText(CONFIG, '+18645550123', 'Hello & bye', fetchFn), 'SM123');
  assert.equal(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.accountSid}/Messages.json`);
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from(`${CONFIG.accountSid}:secret`).toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { To: '+18645550123', MessagingServiceSid: CONFIG.messagingServiceSid, Body: 'Hello & bye' });
});

test('a refused send throws with Twilio’s code', async () => {
  const fetchFn = async () => ({ ok: false, status: 400, json: async () => ({ code: 21610, message: 'Attempt to send to unsubscribed recipient' }) });
  await assert.rejects(sendText(CONFIG, '+18645550123', 'x', fetchFn), (e) => e.code === 21610 && /unsubscribed/.test(e.message));
});

test('settings load once, must be complete, and a failed load is retried', async () => {
  let loads = 0;
  const ok = twilioConfig(async () => { loads++; return JSON.stringify(CONFIG); });
  assert.deepEqual(await ok(), CONFIG);
  await ok();
  assert.equal(loads, 1);
  await assert.rejects(twilioConfig(async () => JSON.stringify({ ...CONFIG, messagingServiceSid: undefined }))(), /messagingServiceSid/);
  let fail = true;
  const flaky = twilioConfig(async () => { if (fail) throw new Error('throttled'); return JSON.stringify(CONFIG); });
  await assert.rejects(flaky(), /throttled/);
  fail = false;
  assert.deepEqual(await flaky(), CONFIG);
});

test('logs never show a whole number', () => assert.equal(maskPhone('+18645550123'), '+1864555****'));
