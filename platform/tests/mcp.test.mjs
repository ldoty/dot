import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServer, toolError } from '../api/mcp.mjs';

const quiet = { error() {} };
const mcp = mcpServer({
  name: 't', title: 'T', log: quiet, tools: [
    { name: 'ok', description: 'd', inputSchema: { type: 'object' }, run: async (a) => ({ got: a.x }) },
    { name: 'said', description: 'd', inputSchema: { type: 'object' }, run: async () => { throw toolError('no such file'); } },
    { name: 'broke', description: 'd', inputSchema: { type: 'object' }, run: async () => { throw new Error('table secret-arn missing'); } },
  ],
});
const call = (name, args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('tools answer text and structured content; listed without run()', async () => {
  const r = await call('ok', { x: 3 });
  assert.deepEqual(r.body.result.structuredContent, { got: 3 });
  assert.match(r.body.result.content[0].text, /"got": 3/);
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.body.result.tools[0].run, undefined);
});

test('a tool’s own error reaches the model; anything else doesn’t', async () => {
  assert.equal((await call('said', {})).body.result.content[0].text, 'no such file');
  const broke = (await call('broke', {})).body.result;
  assert.equal(broke.isError, true);
  assert.doesNotMatch(broke.content[0].text, /secret/);
  assert.equal((await call('ok', [1])).body.error.code, -32602);
});

test('notifications get nothing back; bad messages an error', async () => {
  assert.deepEqual(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), { status: 202, body: null });
  assert.equal((await mcp({ id: 1, method: 'ping' })).body.error.code, -32600);
});
