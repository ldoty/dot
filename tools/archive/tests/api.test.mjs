import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';

const URL = 'https://api.test';
const api = createApi({ group: 'family_archive', issuer: ISSUER, clientId: 'web-client', mcpClientId: 'mcp-client', publicUrl: URL, authDomain: 'auth.test' });
const callApi = caller(api, ['POST /mcp', 'GET /mcp', 'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server']);
const luke = () => accessToken({ clientId: 'mcp-client', group: 'family_archive', sub: '44f8c468-4011-70b8-76aa-ec2b68b0b004', username: 'luke' });
let n = 0;
const rpc = (method, params, token = luke()) => callApi('POST', '/mcp', { jsonrpc: '2.0', id: ++n, method, params }, token);

test('says where Claude Code signs in, without a token', async () => {
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await callApi('GET', path);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.authorization_servers, [URL]);
    assert.equal(r.body.resource, `${URL}/mcp`);
  }
  // …which is the pass-through to the pool's sign-in (mcp-auth.mjs)
  assert.equal((await callApi('GET', '/.well-known/oauth-authorization-server')).body.authorization_endpoint, `${URL}/oauth/authorize`);
});

test('/mcp takes only the MCP client’s tokens, from members, and says where to sign in', async () => {
  const none = await rpc('tools/list', {}, null);
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], `Bearer resource_metadata="${URL}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal((await rpc('tools/list', {}, forgedToken({ clientId: 'mcp-client', group: 'family_archive' }))).status, 401);
  // The page's token can't drive Claude Code's route
  assert.equal((await rpc('tools/list', {}, accessToken({ clientId: 'web-client', group: 'family_archive' }))).status, 401);
  assert.equal((await rpc('tools/list', {}, accessToken({ clientId: 'mcp-client', group: 'family_budget' }))).status, 403);
  // Bound to this server (RFC 8707), fine; bound to another, refused
  assert.equal((await rpc('tools/list', {}, accessToken({ clientId: 'mcp-client', group: 'family_archive', aud: `${URL}/mcp` }))).status, 200);
  assert.equal((await rpc('tools/list', {}, accessToken({ clientId: 'mcp-client', group: 'family_archive', aud: 'https://elsewhere.test/mcp' }))).status, 401);
});

test('speaks MCP: initialize, notifications, tools, errors', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.capabilities.tools);
  // A version we don't know gets our latest; the client decides
  assert.equal((await rpc('initialize', { protocolVersion: '2099-01-01' })).body.result.protocolVersion, '2025-11-25');
  const note = await callApi('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, luke());
  assert.equal(note.status, 202);
  assert.equal(note.body, undefined);
  assert.ok((await rpc('tools/list', {})).body.result.tools.some((t) => t.name === 'whoami'));
  const who = await rpc('tools/call', { name: 'whoami', arguments: {} });
  assert.equal(who.body.result.structuredContent.username, 'luke');
  assert.equal((await rpc('tools/call', { name: 'nope', arguments: {} })).body.error.code, -32602);
  assert.equal((await rpc('no/such', {})).body.error.code, -32601);
  assert.equal((await callApi('POST', '/mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], luke())).status, 400);
  assert.equal((await callApi('GET', '/mcp', undefined, luke())).status, 405);
});
