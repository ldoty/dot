import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationItem, requestPath, sentItem, validateManifest } from '../api/dot-manifest.mjs';

const op = (over = {}) => ({
  name: 'month', description: 'A month', path: '/month/{month}',
  input: { type: 'object', properties: { month: { type: 'string' }, view: { type: 'string' } }, required: ['month'], additionalProperties: false },
  ...over,
});
const manifest = (over = {}) => ({ name: 'finances', title: 'Luke’s Finances', description: 'Money', operations: [op()], ...over });

test('a good manifest passes', () => {
  assert.equal(validateManifest(manifest()).name, 'finances');
});

test('bad manifests are refused, with the reason', () => {
  for (const [m, why] of [
    [null, /not an object/],
    [manifest({ name: 'Finances!' }), /name/],
    [manifest({ operations: [] }), /no operations/],
    [manifest({ operations: [op(), op()] }), /operation name "month"/],
    [manifest({ operations: [op({ path: 'month' })] }), /path/],
    [manifest({ operations: [op({ path: '/../admin' })] }), /path/],
    [manifest({ operations: [op({ input: { type: 'object', properties: {} } })] }), /closed object schema/],
    [manifest({ operations: [op({ path: '/x/{id}' })] }), /path parameter "id"/],
  ]) assert.throws(() => validateManifest(m), why);
});

test('requests: path parameters filled in and encoded, the rest as the query', () => {
  assert.equal(requestPath(op(), { month: '2026-10' }), '/month/2026-10');
  assert.equal(requestPath(op(), { month: '2026-10', view: 'short list' }), '/month/2026-10?view=short+list');
  assert.equal(requestPath(op(), { month: 'a b' }), '/month/a%20b');
  assert.equal(requestPath(op(), { month: '2026-10', nope: 1 }), '/month/2026-10', 'undeclared inputs are dropped');
});

test('a path parameter can’t climb out of its path', () => {
  for (const v of ['../all', '..', 'a/b', '']) assert.throws(() => requestPath(op(), { month: v }), /isn’t a valid value/);
});

const plain = (name, role) => ({ name, description: 'x', path: `/${name}`, role, input: { type: 'object', properties: {}, additionalProperties: false } });

test('roles: automations and sent, once each, with no required inputs', () => {
  assert.ok(validateManifest(manifest({ operations: [op(), plain('autos', 'automations'), plain('sent', 'sent')] })));
  assert.throws(() => validateManifest(manifest({ operations: [plain('a', 'automations'), plain('b', 'automations')] })), /role "automations"/);
  assert.throws(() => validateManifest(manifest({ operations: [plain('a', 'everything')] })), /role "everything"/);
  assert.throws(() => validateManifest(manifest({ operations: [op({ role: 'sent' })] })), /no required inputs/);
});

test('an automation in the shared shape: the common fields, checked; anything else dropped', () => {
  const a = {
    id: 'abc12345', kind: 'house', name: 'Mornings', says: 'Every weekday at 6:00 AM: turn on the kitchen', status: 'stopped', why: 'Luke can’t control it anymore',
    owner: { sub: 's', name: 'Luke' }, mine: true, can_change: true, last_run: { at: '2026-10-19T10:00:00Z', outcome: 'done', results: [] }, next_at: '2026-10-20T10:00:00Z',
    actions: [{ entity_id: 'light.x' }],
  };
  assert.deepEqual(automationItem(a), {
    id: 'abc12345', kind: 'house', name: 'Mornings', says: 'Every weekday at 6:00 AM: turn on the kitchen', status: 'stopped', why: 'Luke can’t control it anymore',
    owner: { name: 'Luke' }, mine: true, can_change: true, last_run: { at: '2026-10-19T10:00:00Z', outcome: 'done' }, next_at: '2026-10-20T10:00:00Z',
  });
  assert.equal(automationItem({ ...a, status: 'on' }).why, undefined, 'a reason only when stopped');
  assert.deepEqual([automationItem({ ...a, last_run: { at: 'x', outcome: 'done' } }).last_run, automationItem({ ...a, next_at: 'soon' }).next_at], [null, null]);
  assert.equal(automationItem({ ...a, mine: 'yes' }).mine, false);
  for (const bad of [{ kind: 'robot' }, { status: 'running' }, { says: ' ' }, { id: undefined }]) assert.equal(automationItem({ ...a, ...bad }), null, JSON.stringify(bad));
});

test('a sent text in the shared shape', () => {
  const x = { sentAt: '2026-10-19T17:30:00Z', channel: 'sms', text: 'Dot-y, Leaving: check the garage', about: 'House automation “Leaving”', automation: 'abc' };
  assert.deepEqual(sentItem(x), { sentAt: x.sentAt, channel: 'sms', text: x.text, about: x.about });
  for (const bad of [{ channel: 'fax' }, { sentAt: 'today' }, { text: '' }, { about: undefined }]) assert.equal(sentItem({ ...x, ...bad }), null, JSON.stringify(bad));
});
