import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpAuth } from '../api/mcp-auth.mjs';

const sent = [];
const fetch = async (url, opts) => {
  sent.push({ url, body: new URLSearchParams(opts.body) });
  const ok = new URLSearchParams(opts.body).get('code') !== 'used';
  return { ok, status: ok ? 200 : 400, json: async () => (ok ? { access_token: 'a', refresh_token: 'r' } : { error: 'invalid_grant' }) };
};
const auth = mcpAuth({ publicUrl: 'https://api.test', authDomain: 'auth.test', clientId: 'mcp', fetch, log: { warn() {} } });
const signIn = { response_type: 'code', client_id: 'mcp', redirect_uri: 'http://localhost:33418/callback', scope: 'openid', state: 's', code_challenge: 'c', code_challenge_method: 'S256' };

test('metadata names our endpoints and S256', () => {
  const m = auth.metadata();
  assert.equal(m.token_endpoint, 'https://api.test/oauth/token');
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
});

test('sign-in goes to the pool without resource, for our client with PKCE only', () => {
  const r = auth.authorize({ ...signIn, resource: 'https://api.test/mcp', prompt: 'none' });
  assert.equal(r.status, 302);
  const u = new URL(r.location);
  assert.equal(u.origin + u.pathname, 'https://auth.test/oauth2/authorize');
  assert.equal(u.searchParams.get('code_challenge'), 'c');
  assert.equal(u.searchParams.has('resource'), false);
  assert.equal(u.searchParams.has('prompt'), false);
  assert.equal(auth.authorize({ ...signIn, client_id: 'web' }).status, 400);
  assert.equal(auth.authorize({ ...signIn, code_challenge_method: 'plain' }).status, 400);
  assert.equal(auth.authorize({ ...signIn, code_challenge: undefined }).status, 400);
});

test('token exchange passes the standard fields through, without resource', async () => {
  sent.length = 0;
  const r = await auth.token('grant_type=authorization_code&client_id=mcp&code=k&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&code_verifier=v&resource=https%3A%2F%2Fapi.test%2Fmcp');
  assert.equal(r.status, 200);
  assert.equal(r.body.access_token, 'a');
  assert.equal(sent[0].url, 'https://auth.test/oauth2/token');
  assert.deepEqual([...sent[0].body.keys()].sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal((await auth.token('grant_type=refresh_token&client_id=mcp&refresh_token=r&resource=x')).status, 200);
  assert.deepEqual([...sent[1].body.keys()].sort(), ['client_id', 'grant_type', 'refresh_token']);
  // Cognito's refusal comes back as it was
  assert.deepEqual((await auth.token('grant_type=authorization_code&client_id=mcp&code=used')).body, { error: 'invalid_grant' });
});

test('only our client, only code and refresh grants; nothing sent otherwise', async () => {
  sent.length = 0;
  assert.equal((await auth.token('grant_type=authorization_code&client_id=web&code=k')).status, 401);
  assert.equal((await auth.token('grant_type=client_credentials&client_id=mcp')).status, 400);
  assert.equal((await auth.token('')).status, 400);
  assert.equal(sent.length, 0);
});
