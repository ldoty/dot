// Dot finding family tools: published apps, the asker's own access, manifests, read-only calls
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDiscovery } from '../api/discovery.mjs';
import { makeTools } from '../api/tools.mjs';
import { systemPrompt } from '../api/agent.mjs';

const FIN = { app: 'luke_finances', api_url: 'https://fin.api', client_id: 'fin-dot' };
const BUDGET = { app: 'family_budget', api_url: 'https://budget.api', client_id: 'budget-dot' };
const MANIFEST = {
  name: 'finances', title: 'Luke’s Finances', description: 'Luke’s accounts filed under his budget',
  operations: [{
    name: 'month', description: 'One month', path: '/month/{month}',
    input: { type: 'object', properties: { month: { type: 'string' } }, required: ['month'], additionalProperties: false },
  }],
};
const LUKE = { sub: 'luke-sub', username: 'luke-sub' }, AMBER = { sub: 'amber-sub', username: 'amber-sub' };

function setup({ apps = [FIN, BUDGET], manifest = MANIFEST, members = { fin: ['luke-sub'] }, answer = (url) => [200, { month: url.split('/').pop(), spent: 12 }] } = {}) {
  const calls = [], audits = [], borrowed = [];
  let listed = 0;
  const d = makeDiscovery({
    listApps: async () => { listed++; return apps; },
    tokenFor: async (who) => {
      borrowed.push(who);
      if (who.clientId === 'fin-dot' && !members.fin.includes(who.sub)) throw Object.assign(new Error('You don\'t have access to luke_finances.'), { denied: true });
      return `${who.clientId}:${who.sub}`;
    },
    fetch: async (url, o) => {
      calls.push({ url, auth: o.headers.authorization });
      const body = (status, b) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
      if (url === 'https://fin.api/dot') return manifest ? body(200, manifest) : body(404, { message: 'Not Found' });
      if (url === 'https://budget.api/dot') return body(404, { message: 'Not Found' });
      return body(...answer(url));
    },
  });
  return { d, calls, audits, borrowed, listed: () => listed, audit: async (e) => audits.push(e) };
}

test('offers a tool’s operations to someone who can use it, as <name>_<operation>', async () => {
  const s = setup();
  const found = await s.d.forUser({ user: LUKE, audit: s.audit });
  assert.deepEqual(found.definitions.map((x) => x.name), ['finances_month']);
  assert.match(found.definitions[0].description, /^Luke’s Finances: One month \(read-only\)$/);
  assert.deepEqual(found.connected, [{ title: 'Luke’s Finances', description: 'Luke’s accounts filed under his budget', tools: ['finances_month'] }]);
  assert.ok(s.calls.some((c) => c.url === 'https://budget.api/dot'), 'Budget was asked, had no manifest, and is skipped');
});

test('someone who isn’t a member isn’t offered the tool at all', async () => {
  const s = setup();
  const found = await s.d.forUser({ user: AMBER, audit: s.audit });
  assert.deepEqual(found.definitions, []);
  assert.ok(!s.calls.some((c) => c.url.startsWith('https://fin.api')), 'not even its manifest');
});

test('a call runs as a GET with the asker’s own token, and is audited', async () => {
  const s = setup();
  const tools = makeTools({ calendarNames: [], discovered: await s.d.forUser({ user: LUKE, channel: 'web', audit: s.audit }) });
  const r = await tools.run({ type: 'tool_use', id: 't1', name: 'finances_month', input: { month: '2026-10' } });
  assert.equal(r.is_error, undefined);
  assert.deepEqual(JSON.parse(r.content), { month: '2026-10', spent: 12 });
  assert.deepEqual(s.calls.at(-1), { url: 'https://fin.api/month/2026-10', auth: 'Bearer fin-dot:luke-sub' });
  assert.deepEqual(s.audits, [{ tool: 'luke_finances', action: 'GET /month/2026-10', outcome: 'ok' }]);
});

test('bad input never reaches the tool; its refusals come back as errors', async () => {
  const s = setup({ answer: () => [403, { error: 'read-only' }] });
  const tools = makeTools({ calendarNames: [], discovered: await s.d.forUser({ user: LUKE, audit: s.audit }) });
  const before = s.calls.length;
  const bad = await tools.run({ type: 'tool_use', id: 't1', name: 'finances_month', input: { month: '../all' } });
  assert.match(bad.content, /isn’t a valid value/);
  const extra = await tools.run({ type: 'tool_use', id: 't2', name: 'finances_month', input: { month: '2026-10', admin: true } });
  assert.match(extra.content, /unknown field "admin"/);
  assert.equal(s.calls.length, before);
  const refused = await tools.run({ type: 'tool_use', id: 't3', name: 'finances_month', input: { month: '2026-10' } });
  assert.equal(refused.is_error, true);
  assert.match(refused.content, /Luke’s Finances answered 403: read-only/);
  assert.equal(s.audits.at(-1).outcome, 'denied');
});

test('manifests and the app list are cached for a few minutes; a broken manifest is skipped', async () => {
  const s = setup();
  await s.d.forUser({ user: LUKE });
  await s.d.forUser({ user: LUKE });
  assert.equal(s.listed(), 1);
  assert.equal(s.calls.filter((c) => c.url.endsWith('/dot')).length, 2, 'one each for Finances and Budget');
  const broken = setup({ manifest: { name: 'x', operations: 'nope' } });
  assert.deepEqual((await broken.d.forUser({ user: LUKE })).definitions, []);
});

test('long answers are cut, and Claude is told', async () => {
  const s = setup({ answer: () => [200, { big: 'x'.repeat(70_000) }] });
  const tools = makeTools({ calendarNames: [], discovered: await s.d.forUser({ user: LUKE }) });
  const r = await tools.run({ type: 'tool_use', id: 't1', name: 'finances_month', input: { month: '2026-10' } });
  assert.match(r.content, /\[cut: the answer was 70010 characters\]$/);
});

test('the system prompt names the connected tools, and that they’re read-only', () => {
  const p = systemPrompt({ name: 'Luke', connected: [{ title: 'Luke’s Finances', description: 'Luke’s accounts', tools: ['finances_month'] }] });
  assert.match(p, /- Luke’s Finances \(finances_month\): Luke’s accounts/);
  assert.match(p, /can't change anything/);
  assert.doesNotMatch(p, /don't have any tools/);
});
