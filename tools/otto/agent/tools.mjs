// Otto's own tools for Claude, as a stdio MCP server (mcp.json starts it for each run), through Otto's
// agent API (api/agent.mjs). send_email: to Luke, from otto@dot-y.co. The address isn't an input: the API
// sends only to the owner's verified email, a few per command, and only while that command is running.
// clear_brief: for Luke's reply to a brief (only then is it allowed, and the API checks it again), it
// queues the brief's clear, whose words are fixed.
// The command comes from OTTO_COMMAND, which otto.mjs sets for the run.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mcpServer, toolError } from './mcp.mjs';

/** deps: api (base URL), key, command, fetchFn */
export function ottoTools({ api, key, command, fetchFn = fetch }) {
  return [{
    name: 'send_email',
    description: 'Email Luke from otto@dot-y.co (the only person Otto can email). For a reply to his email to Otto, it goes in that thread. '
      + 'Plain text; at most 3 per command.',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string', maxLength: 150 }, text: { type: 'string', maxLength: 20000 } },
      required: ['subject', 'text'],
      additionalProperties: false,
    },
    async run({ subject, text }) {
      const res = await fetchFn(`${api}/agent/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-otto-key': key }, body: JSON.stringify({ command, subject, text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw toolError(`not sent: ${j.error ?? res.status}`);
      return 'Sent to Luke.';
    },
  }, {
    name: 'clear_brief',
    description: 'For Luke’s reply to a brief, when he asks to clear it: queues a run that marks the brief’s Otto/Clear mail read and confirms in this thread. Once per reply.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const res = await fetchFn(`${api}/agent/clear`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-otto-key': key }, body: JSON.stringify({ command }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw toolError(`not queued: ${j.error ?? res.status}`);
      return 'Queued: the brief’s Otto/Clear mail will be marked read, and Luke told in this thread.';
    },
  }];
}

/** Newline-delimited JSON-RPC on stdin/stdout (MCP's stdio transport) */
export function serveStdio(mcp, { input = process.stdin, output = process.stdout } = {}) {
  createInterface({ input }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const { body } = await mcp(msg, {});
    if (body) output.write(`${JSON.stringify(body)}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const tools = ottoTools({ api: env.OTTO_API, key: readFileSync(env.OTTO_KEY_FILE || '/etc/otto/agent-key', 'utf8').trim(), command: env.OTTO_COMMAND });
  serveStdio(mcpServer({ name: 'otto', title: 'Otto', tools, log: { error: (...a) => console.error(...a) } }));
}
