// Messages between the relay and AWS (API Gateway WebSocket, route by `type`). Shared by
// relay.mjs and the Lambda (api/protocol.mjs is a symlink here), so both sides check the same shape.
//
// relay -> AWS
//   { type: 'sync', full: true,  areas: [{ id, name }], entities: [Entity…] }   everything exposed:
//                                                        sent on connect and every 5 minutes;
//                                                        rows not in it are removed
//   { type: 'sync', full: false, entities: [Entity…] }   just what changed (batched about a second)
//   { type: 'result', id, ok, error? }                   how a command went
// Entity: { id, name, area, domain, state, attrs, updated, actions }
//   actions: service -> the data keys it takes, from the ceiling, so the page and Dot know what's
//   possible. Only a hint: the relay checks every command against its own ceiling again.
//
// AWS -> relay
//   { type: 'command', id, entity_id, action, data, expires }   expires: epoch ms; the relay drops a
//                                                        command that arrives later, so nothing runs late
//
// API Gateway caps a message at 128 KB, so a sync carries at most MAX_ENTITIES; the ceiling is an
// allowlist, so a house that needs more should be exposing less.

export const MAX_ENTITIES = 300;
export const ID = /^[a-z_]+\.[a-z0-9_]+$/;
export const KEY = /^[a-z_]{1,40}$/;
export const CMD_ID = /^[a-z0-9]{16,40}$/;
const AREA = /^[a-z0-9_]+$/;

const str = (v, max) => typeof v === 'string' && v.length <= max;
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/** service -> [data keys], checked; null if malformed */
function actionsOf(a) {
  if (!plain(a)) return null;
  const out = {};
  for (const [service, keys] of Object.entries(a)) {
    if (!KEY.test(service) || !Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !KEY.test(k))) return null;
    out[service] = [...keys];
  }
  return out;
}

function entity(e) {
  if (!e || !ID.test(e.id ?? '') || e.id.length > 120) return null;
  if (!str(e.name, 120) || !str(e.state, 255) || !str(e.updated, 40)) return null;
  if (e.area !== null && !(typeof e.area === 'string' && AREA.test(e.area))) return null;
  if (e.domain !== e.id.split('.')[0]) return null;
  if (!plain(e.attrs)) return null;
  const attrs = {};
  for (const [k, v] of Object.entries(e.attrs)) {
    if (!KEY.test(k) || !['string', 'number', 'boolean'].includes(typeof v)) return null;
    if (typeof v === 'string' && v.length > 255) return null;
    attrs[k] = v;
  }
  const actions = actionsOf(e.actions);
  if (!actions) return null;
  return { id: e.id, name: e.name, area: e.area, domain: e.domain, state: e.state, attrs, updated: e.updated, actions };
}

/** A sync message, checked and copied field by field; throws with a reason */
export function parseSync(m) {
  const bad = (why) => { throw new Error(`bad sync: ${why}`); };
  if (!m || m.type !== 'sync' || typeof m.full !== 'boolean') bad('type/full');
  if (!Array.isArray(m.entities) || m.entities.length > MAX_ENTITIES) bad('entities');
  const entities = m.entities.map((e) => entity(e) ?? bad(`entity ${String(e?.id).slice(0, 60)}`));
  if (!m.full) return { full: false, entities };
  if (!Array.isArray(m.areas) || m.areas.length > 100) bad('areas');
  const areas = m.areas.map((a) => (a && AREA.test(a.id ?? '') && str(a.name, 120) ? { id: a.id, name: a.name } : bad('area')));
  return { full: true, areas, entities };
}

/** Command data: a flat object of short keys and plain values; throws with a reason */
export function parseData(d) {
  if (d === undefined || d === null) return {};
  if (!plain(d) || Object.keys(d).length > 10) throw new Error('data');
  for (const [k, v] of Object.entries(d)) {
    if (!KEY.test(k)) throw new Error(`data key ${k.slice(0, 40)}`);
    if (!(typeof v === 'number' && Number.isFinite(v)) && typeof v !== 'boolean' && !str(v, 100)) throw new Error(`data ${k}`);
  }
  return { ...d };
}

/** A command, as the relay receives it; throws with a reason */
export function parseCommand(m) {
  if (!m || m.type !== 'command' || !CMD_ID.test(m.id ?? '')) throw new Error('command id');
  if (!ID.test(m.entity_id ?? '') || !KEY.test(m.action ?? '')) throw new Error('command target');
  if (!Number.isFinite(m.expires)) throw new Error('command expires');
  return { id: m.id, entity_id: m.entity_id, action: m.action, data: parseData(m.data), expires: m.expires };
}

/** A result, as AWS receives it; throws with a reason */
export function parseResult(m) {
  if (!m || m.type !== 'result' || !CMD_ID.test(m.id ?? '') || typeof m.ok !== 'boolean') throw new Error('bad result');
  return { id: m.id, ok: m.ok, error: m.ok ? null : String(m.error ?? 'failed').slice(0, 200) };
}
