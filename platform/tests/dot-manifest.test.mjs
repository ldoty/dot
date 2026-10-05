import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPath, validateManifest } from '../api/dot-manifest.mjs';

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
