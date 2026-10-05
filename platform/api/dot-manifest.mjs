// How a dot-y tool describes itself to Dot, so Dot can use it without Dot code for each tool.
//
// A tool that opts in (family-app `delegated = true`, and its API + delegated client published at
// SSM /family/delegation/<app>) serves its manifest at GET /dot:
//
//   {
//     name: 'finances',                 // short prefix for its tools: finances_month, …
//     title: 'Luke’s Finances',
//     description: 'One line: what it holds',
//     operations: [{
//       name: 'month',                  // the tool Claude sees: <name>_<operation>
//       description: 'What it returns and when to use it',
//       path: '/month/{month}',         // GET only; {x} comes from input.x, other inputs go in the query
//       input: { type: 'object', properties: { month: { type: 'string', pattern: '…' } }, required: ['month'], additionalProperties: false },
//     }],
//   }
//
// Dot calls operations with a short-lived, read-only token for the person asking (delegation.mjs),
// so the tool decides what they may see, exactly as for its own page. Only GET: Dot never writes.

const NAME = /^[a-z][a-z0-9_]{0,23}$/;
const PARAM = /\{([a-z][a-z0-9_]*)\}/g;

/** Throws with a reason unless `m` is a usable manifest; returns it */
export function validateManifest(m) {
  const bad = (why) => { throw new Error(`bad manifest: ${why}`); };
  if (!m || typeof m !== 'object') bad('not an object');
  if (!NAME.test(m.name || '')) bad('name');
  if (typeof m.title !== 'string' || !m.title) bad('title');
  if (typeof m.description !== 'string') bad('description');
  if (!Array.isArray(m.operations) || !m.operations.length) bad('no operations');
  const seen = new Set();
  for (const op of m.operations) {
    if (!NAME.test(op.name || '') || seen.has(op.name)) bad(`operation name "${op.name}"`);
    seen.add(op.name);
    if (typeof op.description !== 'string' || !op.description) bad(`${op.name}: description`);
    if (typeof op.path !== 'string' || !op.path.startsWith('/') || /\.\.|\/\//.test(op.path)) bad(`${op.name}: path`);
    const s = op.input;
    if (!s || s.type !== 'object' || typeof s.properties !== 'object' || s.additionalProperties !== false) bad(`${op.name}: input must be a closed object schema`);
    for (const [, p] of op.path.matchAll(PARAM)) {
      if (!s.properties[p] || !(s.required || []).includes(p)) bad(`${op.name}: path parameter "${p}" must be a required input`);
    }
  }
  return m;
}

/** The request path for one call: path parameters filled in, other inputs as the query string */
export function requestPath(op, input = {}) {
  const used = new Set();
  const path = op.path.replace(PARAM, (_, p) => {
    const v = String(input[p] ?? '');
    if (!v || v.includes('/') || v === '.' || v === '..') throw new Error(`"${p}" isn’t a valid value`);
    used.add(p);
    return encodeURIComponent(v);
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (!used.has(k) && v !== undefined && v !== null && op.input.properties[k]) q.set(k, String(v));
  }
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}
