import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('a tool whose OK is given in Claude Code is confirmed at once; every other still isn’t', async () => {
  const apps = [{ app: 'lukes_otto', api_url: 'https://otto.test', client_id: 'otto-dot' }, { app: 'family_health', api_url: 'https://health.test', client_id: 'health-dot' }];
  const calls = [], logs = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body && JSON.parse(opts.body) });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/dot') return reply(200, u.origin === 'https://otto.test'
      ? manifest('otto', 'Otto', [op('schedule_delete', '/schedules/{id}', { method: 'DELETE', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } })])
      : MANIFESTS['https://health.test']);
    if (u.searchParams.get('confirm_id') === 'c1') return reply(200, { deleted: u.pathname });
    return reply(202, { confirm_id: 'c1', prompt: 'Sure?' });
  };
  const connect = makeConnect({ listApps: async () => apps, tokenFor: async () => 't', fetch, confirms: ['lukes_otto'], log: (e) => logs.push(e) });
  const tools = await connect.toolsFor(LUKE);
  assert.deepEqual(await tools.find((t) => t.name === 'otto_schedule_delete').run({ id: 's1' }), { deleted: '/schedules/s1' });
  assert.deepEqual(calls.filter((c) => c.url.startsWith('https://otto.test/schedules')).map((c) => [c.method, c.url]),
    [['DELETE', 'https://otto.test/schedules/s1'], ['DELETE', 'https://otto.test/schedules/s1?confirm_id=c1']], 'the same request, with its confirm id');
  assert.ok(logs.some((l) => l.mcp === 'lukes_otto' && l.outcome === 'confirmed in Claude Code'));
  await assert.rejects(tools.find((t) => t.name === 'health_supplement_change').run({ id: 's1' }), (e) => /needs your OK/.test(e.message));
  assert.ok(!calls.some((c) => c.url.startsWith('https://health.test/supplements') && c.url.includes('confirm_id')));
});

test('only the tools main.tf names are confirmed in Claude Code', () => {
  const tf = readFileSync(new URL('../mcp/main.tf', import.meta.url), 'utf8');
  assert.equal(tf.match(/CONFIRM_APPS\s*=\s*"([^"]*)"/)[1], 'lukes_otto');
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

test('a borrow Cognito throttles is tried again, so the tool doesn’t drop out of the call', async () => {
  const apps = [{ app: 'lukes_otto', api_url: 'https://otto.test', client_id: 'otto-dot' }];
  const m = manifest('otto', 'Otto', [op('status', '/status')]);
  const fetch = async () => ({ ok: true, status: 200, json: async () => m, text: async () => '{}' });
  let tries = 0;
  const waits = [];
  const throttled = () => Object.assign(new Error('Too many requests'), { status: 400 });
  const tokenFor = async () => { if (++tries < 3) throw throttled(); return 't'; };
  const connect = makeConnect({ listApps: async () => apps, tokenFor, fetch, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual((await connect.toolsFor(LUKE)).map((t) => t.name), ['otto_status']);
  assert.equal(waits.length, 2);

  // It gives up in the end (and other refusals are never retried)
  tries = -10;
  const logs = [];
  const gaveUp = makeConnect({ listApps: async () => apps, tokenFor, fetch, sleep: async () => {}, log: (e) => logs.push(e) });
  assert.deepEqual(await gaveUp.toolsFor(LUKE), []);
  assert.equal(tries, -5, 'five tries, no more');
  assert.match(logs[0].error, /Too many requests/);
  let denials = 0;
  const denied = makeConnect({ listApps: async () => apps, fetch, sleep: async () => {}, tokenFor: async () => { denials++; throw Object.assign(new Error('You don’t have access to lukes_otto.'), { denied: true }); } });
  assert.deepEqual(await denied.toolsFor(LUKE), []);
  assert.equal(denials, 1);
});

test('a call signs in only to the tools its name can come from, and names come out as in the full list', async () => {
  const apps = [
    { app: 'luke_finances', api_url: 'https://a.test', client_id: 'a' },
    { app: 'lukes_otto', api_url: 'https://o.test', client_id: 'o' },
    { app: 'shared_finances', api_url: 'https://b.test', client_id: 'b' },
    { app: 'family_lists', api_url: 'https://l.test', client_id: 'l' },
    { app: 'odd_one', api_url: 'https://x.test', client_id: 'x' }, // its manifest isn't named after it
  ];
  const ms = { 'https://a.test': manifest('finances', 'Finances', [op('month', '/month')]), 'https://b.test': manifest('finances', 'Shared', [op('month', '/month')]),
    'https://o.test': manifest('otto', 'Otto', [op('status', '/status')]), 'https://l.test': manifest('lists', 'Lists', [op('all', '/all')]),
    'https://x.test': manifest('quirk', 'Quirk', [op('look', '/look')]) };
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => ms[new URL(url).origin], text: async () => JSON.stringify({ from: new URL(url).origin }) });
  let borrowed = [];
  const connect = makeConnect({ listApps: async () => apps, fetch, tokenFor: async ({ clientId }) => { borrowed.push(clientId); return `t-${clientId}`; } });

  assert.equal((await connect.toolNamed(LUKE, 'otto_status')).name, 'otto_status');
  assert.deepEqual(borrowed, ['o'], 'only Otto');
  borrowed = [];
  assert.deepEqual(await (await connect.toolNamed(LUKE, 'shared_finances_month')).run({}), { from: 'https://b.test' });
  assert.deepEqual(await (await connect.toolNamed(LUKE, 'finances_month')).run({}), { from: 'https://a.test' }, 'the same tool the full list calls finances_month');
  assert.ok(!borrowed.some((c) => c === 'o' || c === 'l' || c === 'x'), 'not the others');
  // A name that doesn't follow the rule is still found, in the full list
  assert.equal((await connect.toolNamed(LUKE, 'quirk_look')).name, 'quirk_look');
  assert.equal(await connect.toolNamed(LUKE, 'nothing_here'), undefined);
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
