// Dot finding the family's tools instead of having code for each one.
//
// Each tool that opts in publishes its API and delegated client at SSM /family/delegation/<app>
// and describes itself at GET /dot (platform/api/dot-manifest.mjs). For one person, Dot:
//   1. lists the published tools,
//   2. borrows a read-only token for that person on each (delegation.mjs); a tool they can't use
//      refuses, and Dot simply doesn't offer it,
//   3. reads each tool's manifest and offers its operations to Claude as <name>_<operation>,
//   4. runs a call as a GET with that person's token, and logs it in the audit log.
// Tools with no manifest (a 404 at /dot, e.g. Budget, which Dot reads with its own code) are skipped.
import { requestPath, validateManifest } from './dot-manifest.mjs';

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

  /** The discovered tools for one person: { definitions, connected, handlers } */
  async function forUser({ user, channel = 'web', audit = async () => {} }) {
    const definitions = [], connected = [], handlers = {};
    for (const app of await published()) {
      let token;
      try {
        token = await tokenFor({ clientId: app.client_id, sub: user.sub, username: user.username, channel });
      } catch (e) {
        if (!e.denied) log({ discovery: app.app, error: e.message });
        continue; // not theirs to use
      }
      const m = await manifestOf(app, token);
      if (!m) continue;
      connected.push({ title: m.title, description: m.description, tools: m.operations.map((op) => `${m.name}_${op.name}`) });
      for (const op of m.operations) {
        const name = `${m.name}_${op.name}`;
        definitions.push({ name, description: `${m.title}: ${op.description} (read-only)`, input_schema: op.input });
        handlers[name] = async (input) => {
          const path = requestPath(op, input);
          const record = (outcome, detail) => audit({ tool: app.app, action: `GET ${path}`, outcome, ...(detail ? { detail } : {}) });
          // The token may have expired since the turn began; tokenFor caches it while it's good
          const t = await tokenFor({ clientId: app.client_id, sub: user.sub, username: user.username, channel });
          const res = await fetch(`${app.api_url}${path}`, { headers: { authorization: `Bearer ${t}` } });
          const text = await res.text();
          if (!res.ok) {
            await record(res.status === 403 ? 'denied' : 'error', `${app.app} ${res.status}`);
            let msg = '';
            try { msg = JSON.parse(text).error || ''; } catch { /* not JSON */ }
            throw new Error(`${m.title} answered ${res.status}${msg ? `: ${msg}` : ''}`);
          }
          await record('ok');
          return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut: the answer was ${text.length} characters]` : text;
        };
      }
    }
    return { definitions, connected, handlers };
  }

  return { forUser };
}
