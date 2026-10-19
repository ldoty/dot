// The household ceiling: the most of Home Assistant that AWS can ever see or touch.
// It lives in git (ceiling.json) and on the relay box, never in AWS, so nothing in the cloud
// can widen it. Per-person grants (api/grants.mjs) only ever narrow what's inside it.
//
// An entity is exposed when its domain is configured AND it isn't excluded AND either it's listed
// by id or its area is listed. Listing an area is how new devices join (a lamp moved into the
// kitchen appears), but only for configured domains, so a camera or lock added to the kitchen
// stays hidden until its domain is added here on purpose.
//
//   domains.<domain>.attributes   the only state attributes reported (no GPS, tokens, etc.)
//   domains.<domain>.actions      service -> the only data keys a command may carry (stage 2)

const ID = /^[a-z_]+\.[a-z0-9_]+$/;
const AREA = /^[a-z0-9_]+$/;

/** Throws with a reason unless `c` is a usable ceiling; returns it */
export function validateCeiling(c) {
  const bad = (why) => { throw new Error(`bad ceiling: ${why}`); };
  const list = (v, re, what) => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !re.test(x))) bad(what);
  };
  if (!c || typeof c !== 'object' || !c.expose || !c.domains) bad('needs expose and domains');
  list(c.expose.areas ?? [], AREA, 'expose.areas');
  list(c.expose.entities ?? [], ID, 'expose.entities');
  list(c.expose.exclude ?? [], ID, 'expose.exclude');
  for (const [domain, d] of Object.entries(c.domains)) {
    if (!/^[a-z_]+$/.test(domain)) bad(`domain "${domain}"`);
    if (!Array.isArray(d.attributes) || !d.actions || typeof d.actions !== 'object') bad(`${domain}: needs attributes and actions`);
    for (const [service, keys] of Object.entries(d.actions)) {
      if (!/^[a-z_]+$/.test(service) || !Array.isArray(keys)) bad(`${domain}.${service}`);
    }
  }
  return c;
}

/** Is this entity (id, area_id or null) inside the ceiling? */
export function exposed(c, id, area) {
  const domain = id.split('.')[0];
  if (!c.domains[domain]) return false;
  if ((c.expose.exclude ?? []).includes(id)) return false;
  return (c.expose.entities ?? []).includes(id) || (!!area && (c.expose.areas ?? []).includes(area));
}

/** One HA state, cut down to what the ceiling reports */
export function reportState(c, s, { name, area }) {
  const domain = s.entity_id.split('.')[0];
  const attrs = {};
  for (const k of c.domains[domain].attributes) {
    if (s.attributes?.[k] !== undefined && s.attributes[k] !== null) attrs[k] = s.attributes[k];
  }
  return { id: s.entity_id, name, area: area ?? null, domain, state: String(s.state), attrs, updated: s.last_updated };
}
