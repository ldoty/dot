// The family's tools, for one person in Claude Code: found the way Dot finds them (tools/assistant/api/
// discovery.mjs), with no code here for any one tool. For each tool published at SSM /family/delegation/<app>:
//   1. borrow a short-lived token for the person (delegation.mjs, signed as `mcp`); a tool that doesn't
//      accept this signer, or that they can't use, refuses, and it simply isn't offered,
//   2. read its manifest (GET /dot, dot-manifest.mjs),
//   3. offer each operation as the MCP tool <name>_<operation>, run with that person's token.
// Writes are offered only as the tool declares them, and the tool still refuses every other non-GET from
// a borrowed token. A write that needs the person's OK (202 { confirm_id }) is not done from here: Dot's
// rule is that only the person's own reply counts, and in Claude Code the model could answer for them.
// So it says where to do it instead. Every call is logged (who, which tool, what, how it went).
import { requestBody, requestPath, validateManifest } from './dot-manifest.mjs';
import { toolError } from './mcp.mjs';

const TTL_MS = 5 * 60_000;
const MAX_CHARS = 100_000; // an answer beyond this is cut, and the model is told so
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function makeConnect({ listApps, tokenFor, fetch = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
  let apps = null, appsAt = 0;
  const manifests = new Map(); // app -> { at, manifest | null }

  async function published() {
    if (!apps || now() - appsAt > TTL_MS) { apps = await listApps(); appsAt = now(); }
    return apps;
  }
  async function manifestOf(app, token) {
    const hit = manifests.get(app.app);
    if (hit && now() - hit.at < TTL_MS) return hit.manifest;
    let manifest = null;
    try {
      const res = await fetch(`${app.api_url}/dot`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) manifest = validateManifest(await res.json());
      else if (res.status !== 404) throw new Error(`GET /dot answered ${res.status}`);
    } catch (e) {
      log({ connect: app.app, error: e.message });
      return null; // not cached: try again next time
    }
    manifests.set(app.app, { at: now(), manifest });
    return manifest;
  }

  /** One tool's operations for this person, or [] if it isn't theirs */
  async function toolsOf(app, user) {
    const borrow = () => tokenFor({ clientId: app.client_id, sub: user.sub, username: user.username, channel: 'mcp' });
    let token;
    try {
      token = await borrow();
    } catch (e) {
      // Not theirs (the group gate), or the tool doesn't take this signer (Cognito's custom auth just fails)
      if (!e.denied && !/Incorrect username or password/.test(e.message)) log({ connect: app.app, error: e.message });
      return [];
    }
    const m = await manifestOf(app, token);
    if (!m) return [];
    return m.operations.map((op) => {
      const method = op.method ?? 'GET';
      return {
        app: app.app, short: `${m.name}_${op.name}`,
        title: `${m.title}: ${op.name.replace(/_/g, ' ')}`,
        description: `${m.title}: ${op.description}${method === 'GET' ? ' (read-only)' : ' (changes things, as you)'}`,
        inputSchema: op.input,
        annotations: { readOnlyHint: method === 'GET', destructiveHint: method === 'DELETE', openWorldHint: false },
        run: async (input) => {
          let path;
          try {
            path = requestPath(op, input);
          } catch (e) {
            throw toolError(e.message);
          }
          const body = method !== 'GET' ? requestBody(op, input) : null;
          const what = `${method} ${path.split('?')[0]}`;
          // Tokens last minutes; tokenFor keeps one while it's good
          const res = await fetch(`${app.api_url}${path}`, {
            method, headers: { authorization: `Bearer ${await borrow()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          const text = await res.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          if (method !== 'GET' && res.status === 202 && parsed?.confirm_id) {
            log({ mcp: app.app, user: user.username, action: what, outcome: 'needs their OK' });
            throw toolError(`${m.title} needs your OK for this (“${String(parsed.prompt || '').slice(0, 300)}”), which can’t be given from Claude Code yet. Do it on ${m.title}’s page, or ask Dot.`);
          }
          log({ mcp: app.app, user: user.username, action: what, outcome: res.ok ? 'ok' : `${res.status}` });
          if (!res.ok) throw toolError(`${m.title} answered ${res.status}${parsed?.error ? `: ${String(parsed.error).slice(0, 300)}` : ''}`);
          if (parsed !== undefined && text.length <= MAX_CHARS) return parsed;
          return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut: the answer was ${text.length} characters]` : text;
        },
      };
    });
  }

  /** Every tool this person can use, as MCP tools (names unique: a clash takes the app's name instead) */
  async function toolsFor(user) {
    const lists = await Promise.all((await published()).map((app) => toolsOf(app, user)));
    const out = [], names = new Set();
    for (const t of lists.flat()) {
      let name = t.short;
      if (names.has(name)) name = `${t.app.replace(/[^a-z0-9]+/g, '_')}_${t.short.split('_').slice(1).join('_')}`;
      if (!TOOL_NAME.test(name) || names.has(name)) { log({ connect: t.app, error: `tool name ${name}` }); continue; }
      names.add(name);
      out.push({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, run: t.run });
    }
    return out;
  }

  return { toolsFor };
}
