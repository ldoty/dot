import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from './helpers/tokens.mjs';
import { caller } from './helpers/http.mjs';
import { makeConnect } from '../mcp/api/connect.mjs';
import { createServer } from '../mcp/api/server.mjs';

const LUKE = { sub: '44f8c468-4011-70b8-76aa-ec2b68b0b004', username: '44f8c468-4011-70b8-76aa-ec2b68b0b004' };
const manifest = (name, title, operations) => ({ name, title, description: `${title}.`, operations });
const op = (name, path, extra = {}) => ({ name, description: `Does ${name}`, path, input: { type: 'object', properties: {}, additionalProperties: false }, ...extra });

// Three tools: Lists (reads and a write), Health (a write that asks first), House (not this person's), Budget (no manifest)
const APPS = [
  { app: 'family_lists', api_url: 'https://lists.test', client_id: 'lists-dot' },
  { app: 'family_health', api_url: 'https://health.test', client_id: 'health-dot' },
  { app: 'family_house', api_url: 'https://house.test', client_id: 'house-dot' },
  { app: 'family_budget', api_url: 'https://budget.test', client_id: 'budget-dot' },
];
const MANIFESTS = {
  'https://lists.test': manifest('lists', 'Lists', [
    op('all', '/all'),
    op('list', '/lists/{id}', { input: { type: 'object', properties: { id: { type: 'string' }, since: { type: 'string' } }, required: ['id'], additionalProperties: false } }),
    op('add', '/lists/{id}/items', { method: 'POST', input: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } }),
  ]),
  'https://health.test': manifest('health', 'Health', [op('supplement_change', '/supplements/{id}', { method: 'PUT', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } })]),
};

function world() {
  const calls = [], logs = [], borrowed = [];
  const tokenFor = async ({ clientId, sub, channel }) => {
    borrowed.push({ clientId, sub, channel });
    if (clientId === 'house-dot') throw Object.assign(new Error('You don’t have access to family_house.'), { denied: true });
    // Budget doesn't list mcp in its delegates: the signer's assertion is refused
    if (clientId === 'budget-dot') throw Object.assign(new Error('Incorrect username or password.'), { status: 400 });
    return `tok-${clientId}`;
  };
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ url, method: opts.method ?? 'GET', auth: opts.headers?.authorization, body: opts.body && JSON.parse(opts.body) });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/dot') return MANIFESTS[u.origin] ? reply(200, MANIFESTS[u.origin]) : reply(404, { error: 'no route' });
    if (u.pathname === '/supplements/s1') return reply(202, { confirm_id: 'c1', prompt: 'Change magnesium to 200 mg?' });
    if (u.pathname === '/lists/missing') return reply(404, { error: 'no such list' });
    return reply(200, { at: u.pathname, query: u.search, body: opts.body ? JSON.parse(opts.body) : null });
  };
  const connect = makeConnect({ listApps: async () => APPS, tokenFor, fetch, log: (e) => logs.push(e) });
  return { connect, calls, logs, borrowed };
}

test('offers each tool the person can use, by its manifest, borrowed as mcp', async () => {
  const { connect, borrowed, logs } = world();
  const tools = await connect.toolsFor(LUKE);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['health_supplement_change', 'lists_add', 'lists_all', 'lists_list']);
  assert.ok(borrowed.every((b) => b.sub === LUKE.sub && b.channel === 'mcp'));
  // A tool that's not theirs, or that doesn't take this signer, is quietly left out
  assert.deepEqual(logs, []);
  const all = tools.find((t) => t.name === 'lists_all');
  assert.equal(all.annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'lists_add').annotations.readOnlyHint, false);
});

test('runs reads and declared writes with the person’s token', async () => {
  const { connect, calls, logs } = world();
  const tools = await connect.toolsFor(LUKE);
  const run = (name, input) => tools.find((t) => t.name === name).run(input);
  assert.deepEqual(await run('lists_list', { id: 'l1', since: '2026-10-01' }), { at: '/lists/l1', query: '?since=2026-10-01', body: null });
  const added = await run('lists_add', { id: 'l1', text: 'Milk' });
  assert.deepEqual(added.body, { text: 'Milk' });
  const write = calls.find((c) => c.method === 'POST');
  assert.equal(write.auth, 'Bearer tok-lists-dot');
  assert.ok(logs.some((l) => l.mcp === 'family_lists' && l.action === 'POST /lists/l1/items' && l.outcome === 'ok'));
  await assert.rejects(run('lists_list', { id: 'missing' }), (e) => e.toolError && /404: no such list/.test(e.message));
  await assert.rejects(run('lists_list', { id: '../x' }), (e) => e.toolError);
});

test('a write that needs the person’s OK isn’t done from here', async () => {
  const { connect, calls, logs } = world();
  const tools = await connect.toolsFor(LUKE);
  await assert.rejects(tools.find((t) => t.name === 'health_supplement_change').run({ id: 's1' }),
    (e) => e.toolError && /needs your OK/.test(e.message) && /Change magnesium/.test(e.message));
  // Never confirmed: the one request is the asking one
  assert.equal(calls.filter((c) => c.url.includes('/supplements/')).length, 1);
  assert.ok(!calls.some((c) => c.url.includes('confirm_id')));
  assert.ok(logs.some((l) => l.outcome === 'needs their OK'));
});

test('two tools with one manifest name both appear', async () => {
  const apps = [
    { app: 'luke_finances', api_url: 'https://a.test', client_id: 'a' },
    { app: 'shared_finances', api_url: 'https://b.test', client_id: 'b' },
  ];
  const m = manifest('finances', 'Finances', [op('month', '/month')]);
  const fetch = async () => ({ ok: true, status: 200, json: async () => m, text: async () => '{}' });
  const connect = makeConnect({ listApps: async () => apps, tokenFor: async () => 't', fetch });
  assert.deepEqual((await connect.toolsFor(LUKE)).map((t) => t.name), ['finances_month', 'shared_finances_month']);
});

// The server around it: sign-in, then MCP
const BASE = 'https://mcp.test';
const { connect } = world();
const server = createServer({ group: 'family_mcp', issuer: ISSUER, clientId: 'mcp-client', publicUrl: BASE, authDomain: 'auth.test', connect });
const callApi = caller(server, ['POST /mcp', 'GET /mcp', 'GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server', 'GET /oauth/authorize']);
const member = (over = {}) => accessToken({ clientId: 'mcp-client', group: 'family_mcp', ...LUKE, ...over });
const rpc = (method, params, token = member()) => callApi('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, token);

test('server: signs in through itself, and takes only family_mcp tokens for its own client', async () => {
  assert.deepEqual((await callApi('GET', '/.well-known/oauth-protected-resource/mcp')).body.authorization_servers, [BASE]);
  assert.equal((await callApi('GET', '/.well-known/oauth-authorization-server')).body.token_endpoint, `${BASE}/oauth/token`);
  const none = await rpc('tools/list', {}, null);
  assert.equal(none.status, 401);
  assert.match(none.headers['www-authenticate'], /resource_metadata=/);
  assert.equal((await rpc('tools/list', {}, forgedToken({ clientId: 'mcp-client', group: 'family_mcp' }))).status, 401);
  assert.equal((await rpc('tools/list', {}, accessToken({ clientId: 'archive-mcp', group: 'family_mcp' }))).status, 401);
  assert.equal((await rpc('tools/list', {}, member({ 'cognito:groups': ['family_archive'] }))).status, 403);
  assert.equal((await rpc('tools/list', {}, member({ aud: 'https://elsewhere.test/mcp' }))).status, 401);
  assert.equal((await rpc('tools/list', {}, member({ aud: `${BASE}/mcp` }))).status, 200);
});

test('server: lists and calls the person’s tools', async () => {
  const list = await rpc('tools/list', {});
  assert.ok(list.body.result.tools.some((t) => t.name === 'lists_all'));
  assert.equal(list.body.result.tools[0].run, undefined);
  const r = await rpc('tools/call', { name: 'lists_all', arguments: {} });
  assert.deepEqual(r.body.result.structuredContent.at, '/all');
  const ask = await rpc('tools/call', { name: 'health_supplement_change', arguments: { id: 's1' } });
  assert.equal(ask.body.result.isError, true);
});
