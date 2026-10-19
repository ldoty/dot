// The house relay: runs in a container on the home server, never in AWS. It holds the only
// Home Assistant token (a non-admin HA user, so even the token can't change HA's setup) and
// dials *out* to the House tool's WebSocket API with the device key, so nothing at home is
// reachable from the internet.
//
// It reports what the ceiling exposes (ceiling.json): a full snapshot on connect and every
// 5 minutes, and changed states batched about a second. It runs commands from AWS only after
// checking them against its own ceiling again: AWS has already checked the person's grants, but
// the ceiling is the line AWS can't move. A command that arrives late, or twice, is dropped.
//
// It also runs the house's automations (automation.mjs): AWS sends the set that may run, the relay
// keeps it on disk and runs each at its time from its own clock, so a 6 AM light comes on with the
// internet down. Each action is checked against the ceiling when it runs, like a command, and how it
// went is reported back (held until AWS is reachable again).
//
// Config (environment, set by house-relay.service):
//   HA_URL           ws://<home assistant>/api/websocket
//   HA_TOKEN_FILE    file holding the relay user's long-lived HA token
//   HOUSE_WS_URL     wss://… the House tool's WebSocket API (tofu output relay_url)
//   HOUSE_KEY_FILE   file holding the device key (same value as SSM /family/house/relay-key)
//   CEILING          path to ceiling.json (default: next to this file)
//   STATE_FILE       where the automations are kept (default /var/lib/house-relay/automations.json)
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { validateCeiling, exposed, refuseCommand, reportState } from './ceiling.mjs';
import { MAX_ENTITIES, parseCommand } from './protocol.mjs';
import { dueKey, parseAutomations } from './automation.mjs';

const env = process.env;
const ceiling = validateCeiling(JSON.parse(readFileSync(env.CEILING ?? new URL('./ceiling.json', import.meta.url), 'utf8')));
const haToken = readFileSync(env.HA_TOKEN_FILE, 'utf8').trim();
const houseKey = readFileSync(env.HOUSE_KEY_FILE, 'utf8').trim();
const FULL_EVERY_MS = 5 * 60_000;
const BATCH_MS = 1000;
// Past this without a working connection to either side, exit and let systemd start a fresh
// process: after the 2026-10-19 power cut a relay started before the network sat silent for good
const STUCK_MS = 2 * 60_000;
const started = Date.now();
let haOkAt = started, awsOkAt = started;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Home Assistant ------------------------------------------------------------------------

let ha = null;           // open, authenticated socket
let haId = 0;
const haPending = new Map();
let registry = { areas: [], areaOf: new Map() }; // entity id -> area id (entity's own, else its device's)
let states = new Map();  // entity id -> HA state, for everything (filtered when reported)
let timeZone = null;     // Home Assistant's, for when automations run

function haCall(msg) {
  return new Promise((resolve, reject) => {
    const id = ++haId;
    haPending.set(id, { resolve, reject });
    ha.send(JSON.stringify({ id, ...msg }));
  });
}

async function loadRegistry() {
  const [areas, devices, entities] = await Promise.all([
    haCall({ type: 'config/area_registry/list' }),
    haCall({ type: 'config/device_registry/list' }),
    haCall({ type: 'config/entity_registry/list' }),
  ]);
  const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
  registry = {
    areas: areas.map((a) => ({ id: a.area_id, name: a.name })),
    areaOf: new Map(entities.map((e) => [e.entity_id, e.area_id ?? deviceArea.get(e.device_id) ?? null])),
  };
}

function report(s) {
  const area = registry.areaOf.get(s.entity_id) ?? null;
  if (!exposed(ceiling, s.entity_id, area)) return null;
  return reportState(ceiling, s, { name: String(s.attributes?.friendly_name ?? s.entity_id).slice(0, 120), area });
}

function connectHa() {
  const ws = new WebSocket(env.HA_URL);
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: haToken }));
    if (m.type === 'auth_invalid') { log('ha: token refused'); return ws.close(); }
    if (m.type === 'auth_ok') {
      ha = ws;
      haOkAt = Date.now();
      try {
        await loadRegistry();
        timeZone = (await haCall({ type: 'get_config' })).time_zone;
        states = new Map((await haCall({ type: 'get_states' })).map((s) => [s.entity_id, s]));
        await haCall({ type: 'subscribe_events', event_type: 'state_changed' });
        for (const t of ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated']) {
          await haCall({ type: 'subscribe_events', event_type: t });
        }
        log(`ha: connected, ${states.size} states`);
        sendFull();
      } catch (e) {
        log('ha: setup failed', e.message);
        ws.close();
      }
      return;
    }
    if (m.type === 'result') {
      const p = haPending.get(m.id);
      if (!p) return;
      haPending.delete(m.id);
      return m.success ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'ha error'));
    }
    if (m.type === 'event') {
      const e = m.event;
      if (e.event_type === 'state_changed') {
        const s = e.data.new_state;
        if (!s) { states.delete(e.data.entity_id); return sendFull(); } // removed: a full sync drops its row
        states.set(s.entity_id, s);
        queueChange(s.entity_id);
      } else {
        // An area, device or entity moved or was renamed: what's exposed may have changed
        loadRegistry().then(sendFull, (err) => log('ha: registry reload failed', err.message));
      }
    }
  };
  ws.onclose = () => {
    if (ha === ws) ha = null;
    for (const p of haPending.values()) p.reject(new Error('ha disconnected'));
    haPending.clear();
    log('ha: disconnected, retrying in 10 s');
    setTimeout(connectHa, 10_000);
  };
  ws.onerror = () => {}; // onclose follows
}

// ---- AWS -----------------------------------------------------------------------------------

let aws = null;
let awsBackoff = 1000;
let changed = new Set();
let batchTimer = null;

function send(msg) {
  if (aws?.readyState === WebSocket.OPEN) aws.send(JSON.stringify(msg));
}

function sendFull() {
  if (!ha) return;
  const entities = [...states.values()].map(report).filter(Boolean);
  if (entities.length > MAX_ENTITIES) {
    log(`ceiling exposes ${entities.length} entities, over ${MAX_ENTITIES}: not syncing; expose less`);
    return;
  }
  send({ type: 'sync', full: true, areas: registry.areas, entities });
}

function queueChange(id) {
  changed.add(id);
  batchTimer ??= setTimeout(() => {
    batchTimer = null;
    const entities = [...changed].map((i) => states.get(i)).filter(Boolean).map(report).filter(Boolean);
    changed = new Set();
    if (entities.length) send({ type: 'sync', full: false, entities });
  }, BATCH_MS);
}

const seen = new Set(); // recent command ids: a replayed command never runs twice

async function runCommand(m) {
  let cmd;
  try {
    cmd = parseCommand(m);
  } catch (e) {
    return log('aws: ignored a malformed message', e.message);
  }
  const answer = (ok, error) => {
    log(`command ${cmd.id} ${cmd.action} ${cmd.entity_id}: ${ok ? 'done' : error}`);
    send({ type: 'result', id: cmd.id, ok, ...(ok ? {} : { error }) });
  };
  if (seen.has(cmd.id)) return log(`command ${cmd.id}: already seen, dropped`);
  seen.add(cmd.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  if (Date.now() > cmd.expires) return answer(false, 'arrived too late');
  const why = refuseCommand(ceiling, cmd, registry.areaOf.get(cmd.entity_id) ?? null);
  if (why) return answer(false, `refused: ${why}`);
  if (!ha) return answer(false, 'Home Assistant is offline');
  const [domain, service] = [cmd.entity_id.split('.')[0], cmd.action];
  try {
    await haCall({ type: 'call_service', domain, service, service_data: cmd.data, target: { entity_id: cmd.entity_id } });
    answer(true);
  } catch (e) {
    answer(false, e.message.slice(0, 200));
  }
}

function connectAws() {
  // Node's WebSocket sends extra headers; the key never goes in the URL, where it would be logged
  const ws = new WebSocket(env.HOUSE_WS_URL, { headers: { 'x-house-key': houseKey } });
  ws.onopen = () => {
    aws = ws;
    awsOkAt = Date.now();
    awsBackoff = 1000;
    log('aws: connected');
    sendFull();
    flushRan();
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return log('aws: ignored a message that isn’t JSON');
    }
    return m?.type === 'automations' ? takeAutomations(m) : runCommand(m);
  };
  ws.onclose = (ev) => {
    if (aws === ws) aws = null;
    log(`aws: closed (${ev.code}), retrying in ${awsBackoff / 1000} s`);
    setTimeout(connectAws, awsBackoff);
    awsBackoff = Math.min(awsBackoff * 2, 60_000);
  };
  ws.onerror = () => {};
}

// ---- automations ---------------------------------------------------------------------------

const STATE_FILE = env.STATE_FILE ?? '/var/lib/house-relay/automations.json';
// { at, items, fired: { <id>: <key of its last run> } }; `fired` survives restarts, so nothing runs twice
let auto = { at: null, items: [], fired: {} };
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  auto = { ...parseAutomations({ type: 'automations', at: saved.at, items: saved.items }), fired: saved.fired ?? {} };
  log(`automations: ${auto.items.length} from disk`);
} catch (e) {
  if (e.code !== 'ENOENT') log('automations: none kept on disk', e.message);
}
function saveAutomations() {
  try {
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(auto));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (e) {
    log('automations: couldn’t save', e.message);
  }
}

function takeAutomations(m) {
  let got;
  try {
    got = parseAutomations(m);
  } catch (e) {
    return log('aws: ignored automations', e.message);
  }
  if (auto.at && Date.parse(got.at) < Date.parse(auto.at)) return; // an older set, sent before the one we have
  const ids = new Set(got.items.map((a) => a.id));
  auto = { ...got, fired: Object.fromEntries(Object.entries(auto.fired).filter(([id]) => ids.has(id))) };
  saveAutomations();
}

const unsent = []; // run reports waiting for AWS
function flushRan() {
  while (unsent.length && aws?.readyState === WebSocket.OPEN) send(unsent.shift());
}

let running = false;
async function runDue() {
  if (running || !ha || !timeZone) return; // without Home Assistant nothing can run; it may still in time
  running = true;
  try {
    const now = new Date();
    const sun = states.get('sun.sun')?.attributes;
    for (const a of auto.items) {
      const key = dueKey(a, now, timeZone, sun);
      if (!key || auto.fired[a.id] === key) continue;
      auto.fired[a.id] = key;
      saveAutomations();
      const results = [];
      for (const x of a.actions) {
        const why = refuseCommand(ceiling, x, registry.areaOf.get(x.entity_id) ?? null);
        if (why) {
          results.push({ entity_id: x.entity_id, action: x.action, ok: false, error: `refused: ${why}` });
          continue;
        }
        try {
          await haCall({ type: 'call_service', domain: x.entity_id.split('.')[0], service: x.action, service_data: x.data, target: { entity_id: x.entity_id } });
          results.push({ entity_id: x.entity_id, action: x.action, ok: true });
        } catch (e) {
          results.push({ entity_id: x.entity_id, action: x.action, ok: false, error: e.message.slice(0, 200) });
        }
      }
      log(`automation ${a.id} "${a.name}" ${key}: ${results.map((r) => (r.ok ? 'done' : r.error)).join(', ')}`);
      unsent.push({ type: 'ran', id: a.id, key, at: now.toISOString(), results });
      if (unsent.length > 50) unsent.shift();
      flushRan();
    }
  } finally {
    running = false;
  }
}

connectHa();
connectAws();
setInterval(() => runDue().catch((e) => log('automations:', e.message)), 15_000);
setInterval(sendFull, FULL_EVERY_MS); // also keeps the connection inside API Gateway's 10-minute idle limit
setInterval(() => {
  const now = Date.now();
  if (ha) haOkAt = now;
  if (aws?.readyState === WebSocket.OPEN) awsOkAt = now;
  const down = [now - haOkAt > STUCK_MS && 'Home Assistant', now - awsOkAt > STUCK_MS && 'AWS'].filter(Boolean);
  if (down.length) {
    log(`no connection to ${down.join(' or ')} for over 2 minutes: exiting so systemd restarts the relay`);
    process.exit(1);
  }
}, 15_000);
