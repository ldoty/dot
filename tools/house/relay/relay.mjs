// The house relay: runs in a container on the home server, never in AWS. It holds the only
// Home Assistant token (a non-admin HA user, so even the token can't change HA's setup) and
// dials *out* to the House tool's WebSocket API with the device key, so nothing at home is
// reachable from the internet.
//
// It reports what the ceiling exposes (ceiling.json): a full snapshot on connect and every
// 5 minutes, and changed states batched about a second. Commands arrive in stage 2.
//
// Config (environment, set by house-relay.service):
//   HA_URL           ws://<home assistant>/api/websocket
//   HA_TOKEN_FILE    file holding the relay user's long-lived HA token
//   HOUSE_WS_URL     wss://… the House tool's WebSocket API (tofu output relay_url)
//   HOUSE_KEY_FILE   file holding the device key (same value as SSM /family/house/relay-key)
//   CEILING          path to ceiling.json (default: next to this file)
import { readFileSync } from 'node:fs';
import { validateCeiling, exposed, reportState } from './ceiling.mjs';
import { MAX_ENTITIES } from './protocol.mjs';

const env = process.env;
const ceiling = validateCeiling(JSON.parse(readFileSync(env.CEILING ?? new URL('./ceiling.json', import.meta.url), 'utf8')));
const haToken = readFileSync(env.HA_TOKEN_FILE, 'utf8').trim();
const houseKey = readFileSync(env.HOUSE_KEY_FILE, 'utf8').trim();
const FULL_EVERY_MS = 5 * 60_000;
const BATCH_MS = 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Home Assistant ------------------------------------------------------------------------

let ha = null;           // open, authenticated socket
let haId = 0;
const haPending = new Map();
let registry = { areas: [], areaOf: new Map() }; // entity id -> area id (entity's own, else its device's)
let states = new Map();  // entity id -> HA state, for everything (filtered when reported)

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
      try {
        await loadRegistry();
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

function connectAws() {
  // Node's WebSocket sends extra headers; the key never goes in the URL, where it would be logged
  const ws = new WebSocket(env.HOUSE_WS_URL, { headers: { 'x-house-key': houseKey } });
  ws.onopen = () => {
    aws = ws;
    awsBackoff = 1000;
    log('aws: connected');
    sendFull();
  };
  ws.onmessage = (ev) => log('aws: message', String(ev.data).slice(0, 200)); // commands: stage 2
  ws.onclose = (ev) => {
    if (aws === ws) aws = null;
    log(`aws: closed (${ev.code}), retrying in ${awsBackoff / 1000} s`);
    setTimeout(connectAws, awsBackoff);
    awsBackoff = Math.min(awsBackoff * 2, 60_000);
  };
  ws.onerror = () => {};
}

connectHa();
connectAws();
setInterval(sendFull, FULL_EVERY_MS); // also keeps the connection inside API Gateway's 10-minute idle limit
