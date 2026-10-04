import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from './helpers/tokens.mjs';
import { verifyAccessToken } from '../api/verify-token.mjs';

const opts = { issuer: ISSUER, clientId: 'tool-client', group: 'tool_group' };
const ok = { clientId: 'tool-client', group: 'tool_group' };
const check = (token) => verifyAccessToken({ authorization: `Bearer ${token}` }, opts);
const status = (p) => p.then(() => 200, (e) => e.status);

test('accepts a valid token and returns its claims', async () => {
  const c = await check(accessToken(ok));
  assert.equal(c.client_id, 'tool-client');
});

test('rejects missing, malformed and forged tokens with 401', async () => {
  assert.equal(await status(verifyAccessToken({}, opts)), 401);
  assert.equal(await status(check('abc.def')), 401);
  assert.equal(await status(check('a.b.c')), 401);
  assert.equal(await status(check(forgedToken(ok))), 401);
});

test('rejects alg=none', async () => {
  const [, p] = accessToken(ok).split('.');
  const h = Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key' })).toString('base64url');
  assert.equal(await status(check(`${h}.${p}.x`)), 401);
});

test('rejects wrong issuer, ID tokens, another tool’s client and expired tokens', async () => {
  assert.equal(await status(check(accessToken({ ...ok, iss: 'https://evil' }))), 401);
  assert.equal(await status(check(accessToken({ ...ok, token_use: 'id' }))), 401);
  assert.equal(await status(check(accessToken({ ...ok, clientId: 'other-tool' }))), 401);
  assert.equal(await status(check(accessToken({ ...ok, exp: 1 }))), 401);
});

test('rejects users outside the tool’s group with 403', async () => {
  assert.equal(await status(check(accessToken({ clientId: 'tool-client', group: 'other_group' }))), 403);
});

test('a list of clients accepts any of them (a tool and its delegated client)', async () => {
  const both = { ...opts, clientId: ['tool-client', 'tool-dot'] };
  const c = await verifyAccessToken({ authorization: `Bearer ${accessToken({ clientId: 'tool-dot', group: 'tool_group' })}` }, both);
  assert.equal(c.client_id, 'tool-dot');
  assert.equal(await status(verifyAccessToken({ authorization: `Bearer ${accessToken({ clientId: 'other', group: 'tool_group' })}` }, both)), 401);
});
