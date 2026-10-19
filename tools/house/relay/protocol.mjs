// Messages between the relay and AWS (API Gateway WebSocket, route by `type`). Shared by
// relay.mjs and the Lambda (api/protocol.mjs is a symlink here), so both sides check the same shape.
//
// relay -> AWS
//   { type: 'sync', full: true,  areas: [{ id, name }], entities: [Entity…] }   everything exposed:
//                                                        sent on connect and every 5 minutes;
//                                                        rows not in it are removed
//   { type: 'sync', full: false, entities: [Entity…] }   just what changed (batched about a second)
// Entity: { id, name, area, domain, state, attrs, updated }
//
// API Gateway caps a message at 128 KB, so a sync carries at most MAX_ENTITIES; the ceiling is an
// allowlist, so a house that needs more should be exposing less.

export const MAX_ENTITIES = 300;
const ID = /^[a-z_]+\.[a-z0-9_]+$/;
const AREA = /^[a-z0-9_]+$/;

const str = (v, max) => typeof v === 'string' && v.length <= max;

function entity(e) {
  if (!e || !ID.test(e.id ?? '') || e.id.length > 120) return null;
  if (!str(e.name, 120) || !str(e.state, 255) || !str(e.updated, 40)) return null;
  if (e.area !== null && !(typeof e.area === 'string' && AREA.test(e.area))) return null;
  if (e.domain !== e.id.split('.')[0]) return null;
  if (!e.attrs || typeof e.attrs !== 'object' || Array.isArray(e.attrs)) return null;
  const attrs = {};
  for (const [k, v] of Object.entries(e.attrs)) {
    if (!/^[a-z_]{1,40}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v)) return null;
    if (typeof v === 'string' && v.length > 255) return null;
    attrs[k] = v;
  }
  return { id: e.id, name: e.name, area: e.area, domain: e.domain, state: e.state, attrs, updated: e.updated };
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
