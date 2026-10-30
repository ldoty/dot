import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { createApi } from '../api/api.mjs';

const api = createApi({ group: 'family_archive', issuer: ISSUER, clientId: 'web-client' });
const call = async (token) => (await api({ routeKey: 'GET /x', headers: token ? { authorization: `Bearer ${token}` } : {} })).statusCode;

test('refuses missing, forged, wrong-group and other-tool tokens before anything else', async () => {
  assert.equal(await call(null), 401);
  assert.equal(await call(forgedToken({ clientId: 'web-client', group: 'family_archive' })), 401);
  assert.equal(await call(accessToken({ clientId: 'web-client', group: 'family_budget' })), 403);
  assert.equal(await call(accessToken({ clientId: 'archive-mcp', group: 'family_archive' })), 401);
  assert.equal(await call(accessToken({ clientId: 'web-client', group: 'family_archive' })), 404);
});
