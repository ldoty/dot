import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { createHandler } from '../api/handler.mjs';
import { deps, table } from './helpers/deps.mjs';
import { text, toolUse } from './helpers/fake-claude.mjs';

const AUTH = { issuer: ISSUER, clientId: 'assistant-client', group: 'lukes_assistant' };
const member = () => accessToken({ clientId: 'assistant-client', group: 'lukes_assistant', sub: 'luke-sub' });
beforeEach(() => table.clear());

function call(handle, method, path, { body, token = member() } = {}) {
  const res = { status: null, type: null, chunks: [], ended: false };
  return handle({
    rawPath: path, requestContext: { http: { method } },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }, (status, type) => { res.status = status; res.type = type; return { write: (c) => res.chunks.push(c), end: () => { res.ended = true; } }; })
    .then(() => ({ ...res, json: () => JSON.parse(res.chunks.join('')), lines: () => res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l)) }));
}
const handlerWith = (script) => { const d = deps(script); return { ...d, handle: createHandler({ ...d.deps, auth: AUTH }) }; };

test('refuses missing, forged, wrong-group and other-app tokens', async () => {
  const { handle, claude } = handlerWith([]);
  assert.equal((await call(handle, 'GET', '/conversations', { token: null })).status, 401);
  assert.equal((await call(handle, 'GET', '/conversations', { token: forgedToken({ clientId: 'assistant-client', group: 'lukes_assistant' }) })).status, 401);
  assert.equal((await call(handle, 'POST', '/chat', { body: { text: 'hi' }, token: accessToken({ clientId: 'assistant-client', group: 'family_budget' }) })).status, 403);
  assert.equal((await call(handle, 'POST', '/chat', { body: { text: 'hi' }, token: accessToken({ clientId: 'budget-client', group: 'lukes_assistant' }) })).status, 401);
  assert.equal(claude.calls.length, 0, 'Claude is never called without a valid token');
});

test('POST /chat streams one JSON event per line, ending with done', async () => {
  const { handle } = handlerWith([toolUse('list_calendars', {}), text('You have two calendars.')]);
  const r = await call(handle, 'POST', '/chat', { body: { text: 'Which calendars?' } });
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/x-ndjson');
  assert.ok(r.ended);
  const events = r.lines();
  assert.equal(events[0].type, 'conversation');
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.status), ['running', 'done']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'You have two calendars.');
  assert.deepEqual(events.at(-1), { type: 'done' });
});

test('conversations are listed, reopened as a transcript, and deleted', async () => {
  const { handle } = handlerWith([text('Hello!')]);
  const id = (await call(handle, 'POST', '/chat', { body: { text: 'Hi there' } })).lines()[0].id;
  const list = (await call(handle, 'GET', '/conversations')).json();
  assert.deepEqual(list.map((c) => [c.id, c.title]), [[id, 'Hi there']]);
  const conv = (await call(handle, 'GET', `/conversations/${id}`)).json();
  assert.deepEqual(conv.transcript, [{ role: 'user', text: 'Hi there' }, { role: 'assistant', text: 'Hello!', tools: [] }]);
  assert.equal((await call(handle, 'DELETE', `/conversations/${id}`)).status, 200);
  assert.deepEqual((await call(handle, 'GET', '/conversations')).json(), []);
  assert.deepEqual(table.keys(), [], 'messages are deleted too');
});

test('another user can’t see or continue your conversations', async () => {
  const { handle } = handlerWith([text('Hello!')]);
  const id = (await call(handle, 'POST', '/chat', { body: { text: 'Hi' } })).lines()[0].id;
  const other = accessToken({ clientId: 'assistant-client', group: 'lukes_assistant', sub: 'someone-else' });
  assert.deepEqual((await call(handle, 'GET', '/conversations', { token: other })).json(), []);
  assert.equal((await call(handle, 'GET', `/conversations/${id}`, { token: other })).status, 404);
  const cont = (await call(handle, 'POST', '/chat', { body: { text: 'more', conversationId: id }, token: other })).lines();
  assert.match(cont.find((e) => e.type === 'error').message, /no longer exists/);
});

test('validates input', async () => {
  const { handle } = handlerWith([]);
  assert.equal((await call(handle, 'POST', '/chat', { body: { text: '  ' } })).status, 400);
  assert.equal((await call(handle, 'POST', '/chat', { body: { text: 'x'.repeat(8001) } })).status, 400);
  assert.equal((await call(handle, 'POST', '/chat', { body: { text: 'hi', conversationId: '../x' } })).status, 400);
  assert.equal((await call(handle, 'GET', '/nope')).status, 404);
});

test('a failure mid-turn ends the stream with an error and done', async () => {
  const { handle } = handlerWith([() => { throw new Error('Bedrock is down'); }]);
  const events = (await call(handle, 'POST', '/chat', { body: { text: 'hi' } })).lines();
  assert.deepEqual(events.slice(-2), [{ type: 'error', message: 'Something went wrong. Try again.' }, { type: 'done' }]);
});

test('a Bedrock permission error says model access is the problem', async () => {
  const denied = new Anthropic.PermissionDeniedError(403, { type: 'error', error: { type: 'permission_error', message: 'not available for this account' } }, 'not available', new Headers());
  const { handle } = handlerWith([() => { throw denied; }]);
  const events = (await call(handle, 'POST', '/chat', { body: { text: 'hi' } })).lines();
  assert.match(events.find((e) => e.type === 'error').message, /isn’t enabled for this AWS account/);
});
