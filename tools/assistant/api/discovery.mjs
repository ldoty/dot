// Dot finding the family's tools instead of having code for each one.
//
// Each tool that opts in publishes its API and delegated client at SSM /family/delegation/<app>
// and describes itself at GET /dot (platform/api/dot-manifest.mjs). For one person, Dot:
//   1. lists the published tools,
//   2. borrows a read-only token for that person on each (delegation.mjs); a tool they can't use
//      refuses, and Dot simply doesn't offer it,
//   3. reads each tool's manifest and offers its operations to Claude as <name>_<operation>,
//   4. runs a call with that person's token, and logs it in the audit log.
// A write the manifest declares (dot-manifest.mjs, Writes) is offered with a `confirm` field: when the
// tool answers 202 { confirm_id, prompt }, Dot asks the person and stops; the confirmation goes back only
// after their own reply (confirm.mjs), and it's exactly the request that was asked about, never a new one
// from the confirming call. Writes are named in `writes`, so a read-only run (a scheduled ask) leaves them out.
// Tools with no manifest (a 404 at /dot, e.g. Budget, which Dot reads with its own code) are skipped.
// An operation with a role (dot-manifest.mjs: 'automations', 'sent') is also handed back under it, so
// Dot can put every tool's automations in one list, and read what was texted to someone before they reply.
import { requestBody, requestPath, validateManifest } from './dot-manifest.mjs';
import { asking, pendingIn } from './confirm.mjs';

const TTL_MS = 5 * 60_000;
const MAX_CHARS = 60_000; // a tool's answer beyond this is cut, and Claude is told so

export function makeDiscovery({ listApps, tokenFor, fetch = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
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
      log({ discovery: app.app, error: e.message });
      return null; // not cached: try again next turn
    }
    manifests.set(app.app, { at: now(), manifest });
    return manifest;
  }

  /**
   * The discovered tools for one person: { definitions, connected, handlers, apps, roles, writes } (apps: every tool
   * they can use; roles: { automations: [{ tool, run }], sent: [...] }, run() -> the operation's answer, parsed;
   * writes: the names of the tools that change things)
   */
  async function forUser({ user, channel = 'web', audit = async () => {} }) {
    const definitions = [], connected = [], handlers = {}, apps = {}, roles = { automations: [], sent: [] }, writes = [];
    for (const app of await published()) {
      let token;
      try {
        token = await tokenFor({ clientId: app.client_id, sub: user.sub, username: user.username, channel });
      } catch (e) {
        if (!e.denied) log({ discovery: app.app, error: e.message });
        continue; // not theirs to use
      }
      // Usable by this person, manifest or not (Calendars has none: Dot's calendar tools are built in)
      apps[app.app] = { api_url: app.api_url, client_id: app.client_id };
      const m = await manifestOf(app, token);
      if (!m) continue;
      connected.push({ title: m.title, description: m.description, tools: m.operations.map((op) => `${m.name}_${op.name}`) });
      for (const op of m.operations) {
        const name = `${m.name}_${op.name}`;
        const method = op.method ?? 'GET';
        if (method === 'GET') definitions.push({ name, description: `${m.title}: ${op.description} (read-only)`, input_schema: op.input });
        else {
          writes.push(name);
          definitions.push({
            name, description: `${m.title}: ${op.description} (changes things, as them). If the answer says it needs their confirmation, ask them in plain words `
              + 'and wait for their reply; only if they agree, call it again with confirm: true.',
            // Only the ids in its path are required: a confirming call sends just those and confirm, and the tool checks the rest
            input_schema: {
              ...op.input,
              properties: { ...op.input.properties, confirm: { type: 'boolean', description: 'Only after the person agreed' } },
              required: (op.input.required ?? []).filter((k) => op.path.includes(`{${k}}`)),
            },
          });
        }
        handlers[name] = async ({ confirm, ...input } = {}, { history = [] } = {}) => {
          let req;
          if (method !== 'GET' && confirm) {
            // Exactly what they were asked about: the request recorded when the tool asked
            const p = pendingIn(history, name);
            // A confirming call that names something else (another id) isn't a yes to what was asked
            let named = null;
            try { named = requestPath(op, input); } catch { /* no ids given: it's the one asked about */ }
            if (!p || (named && named !== p.path)) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
            if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
            req = { path: `${p.path}?confirm_id=${encodeURIComponent(p.confirm_id)}`, body: p.body };
          } else {
            req = { path: requestPath(op, input), ...(method !== 'GET' ? { body: requestBody(op, input) } : {}) };
          }
          const what = `${method} ${req.path.split('?')[0]}${confirm ? ' (confirmed)' : ''}`;
          const record = (outcome, detail) => audit({ tool: app.app, action: what, outcome, ...(detail ? { detail } : {}) });
          // The token may have expired since the turn began; tokenFor caches it while it's good
          const t = await tokenFor({ clientId: app.client_id, sub: user.sub, username: user.username, channel });
          const res = await fetch(`${app.api_url}${req.path}`, {
            method, headers: { authorization: `Bearer ${t}`, ...(req.body ? { 'content-type': 'application/json' } : {}) },
            ...(req.body ? { body: JSON.stringify(req.body) } : {}),
          });
          const text = await res.text();
          if (!res.ok) {
            await record(res.status === 403 ? 'denied' : 'error', `${app.app} ${res.status}`);
            let msg = '';
            try { msg = JSON.parse(text).error || ''; } catch { /* not JSON */ }
            throw new Error(`${m.title} answered ${res.status}${msg ? `: ${msg}` : ''}`);
          }
          if (method !== 'GET' && res.status === 202) {
            let out = {};
            try { out = JSON.parse(text); } catch { /* not JSON */ }
            if (out.confirm_id) {
              await record('asked', out.prompt);
              return asking(name, { ask_them: out.prompt, confirm_id: out.confirm_id, path: req.path, body: req.body });
            }
          }
          await record('ok');
          return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut: the answer was ${text.length} characters]` : text;
        };
        if (op.role && roles[op.role]) roles[op.role].push({ tool: m.title, run: async () => JSON.parse(await handlers[name]({})) });
      }
    }
    return { definitions, connected, handlers, apps, roles, writes };
  }

  return { forUser };
}
