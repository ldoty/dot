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
//
// Roles. An operation may also say it's one of the shapes every tool answers alike, so Dot can put
// the family's tools side by side without code for each (at most one operation per role, no inputs
// required):
//   role: 'automations'  what runs on its own for this person: [Automation] (automationItem below).
//                        Dot lists them with its own scheduled asks, as one list ("what runs on its own?")
//   role: 'sent'         what the tool texted or emailed this person lately, newest first: [Sent]
//                        (sentItem below). When they text or email Dot, it reads these first, so a
//                        reply to one ("turn them off then", "done") makes sense

const NAME = /^[a-z][a-z0-9_]{0,23}$/;
export const ROLES = ['automations', 'sent'];
const PARAM = /\{([a-z][a-z0-9_]*)\}/g;

/** Throws with a reason unless `m` is a usable manifest; returns it */
export function validateManifest(m) {
  const bad = (why) => { throw new Error(`bad manifest: ${why}`); };
  if (!m || typeof m !== 'object') bad('not an object');
  if (!NAME.test(m.name || '')) bad('name');
  if (typeof m.title !== 'string' || !m.title) bad('title');
  if (typeof m.description !== 'string') bad('description');
  if (!Array.isArray(m.operations) || !m.operations.length) bad('no operations');
  const seen = new Set(), roles = new Set();
  for (const op of m.operations) {
    if (op.role !== undefined) {
      if (!ROLES.includes(op.role) || roles.has(op.role)) bad(`${op.name}: role "${op.role}"`);
      roles.add(op.role);
      if ((op.input?.required ?? []).length) bad(`${op.name}: a role takes no required inputs`);
    }
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

// ---- the shapes roles answer in ----

export const KINDS = ['house', 'ask', 'reminder'];
const STATUS = ['on', 'paused', 'stopped'];
const OUTCOMES = ['done', 'failed', 'missed'];
const iso = (x) => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const words = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);

/**
 * One automation as every tool gives it, or null if it isn't one (a tool's other fields are dropped):
 *   { id, kind: house | ask | reminder, name, says (what it does, in words), status: on | paused | stopped,
 *     why? (stopped), owner: { name }?, mine, can_change, last_run: { at, outcome: done | failed | missed } | null,
 *     next_at: ISO | null }
 */
export function automationItem(x) {
  if (!x || typeof x !== 'object') return null;
  const id = words(x.id, 80), name = words(x.name, 120), says = words(x.says, 600);
  if (!id || !name || !says || !KINDS.includes(x.kind) || !STATUS.includes(x.status)) return null;
  const last = x.last_run && iso(x.last_run.at) && OUTCOMES.includes(x.last_run.outcome) ? { at: x.last_run.at, outcome: x.last_run.outcome } : null;
  return {
    id, kind: x.kind, name, says, status: x.status, ...(x.status === 'stopped' && words(x.why, 200) ? { why: words(x.why, 200) } : {}),
    ...(words(x.owner?.name, 80) ? { owner: { name: words(x.owner.name, 80) } } : {}),
    mine: x.mine === true, can_change: x.can_change === true, last_run: last, next_at: iso(x.next_at) ? x.next_at : null,
  };
}

/** One text or email a tool sent this person, or null: { sentAt, channel: sms | email, text, about (what sent it, in words) } */
export function sentItem(x) {
  if (!x || typeof x !== 'object' || !iso(x.sentAt) || !['sms', 'email'].includes(x.channel)) return null;
  const text = words(x.text, 600), about = words(x.about, 120);
  return text && about ? { sentAt: x.sentAt, channel: x.channel, text, about } : null;
}
