// Who may do what to which device, inside the ceiling the relay enforces (relay/ceiling.mjs).
//
// A grant is { who, where, level }:
//   who    'sub:<cognito sub>' or 'group:<name>' (a GROUP row lists its members' subs)
//   where  '*', 'area:<area id>' or 'entity:<entity id>'
//   level  read < confirm < control   (confirm: may control, but Dot asks first)
// No matching grant means no access, grants only add, and the highest matching level wins, so a
// broad `read` plus a kitchen `control` is control in the kitchen and read elsewhere. Areas are
// matched against the entity's area *now*, so a lamp moved into the kitchen follows the kitchen's
// grants. Admins (family_house:admin) have control everywhere: they set the grants.

export const LEVELS = ['none', 'read', 'confirm', 'control'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));

const WHO = /^(sub:[0-9a-f-]{36}|group:[a-z0-9_-]{1,40})$/;
const WHERE = /^(\*|area:[a-z0-9_]+|entity:[a-z_]+\.[a-z0-9_]+)$/;

/** A grant from a request body, or throws with a reason */
export function parseGrant(g) {
  if (!g || !WHO.test(g.who ?? '')) throw new Error('who');
  if (!WHERE.test(g.where ?? '')) throw new Error('where');
  if (!LEVELS.includes(g.level) || g.level === 'none') throw new Error('level');
  return { who: g.who, where: g.where, level: g.level };
}

/** The grants that apply to this person: their own and their groups' */
export function grantsFor(sub, grants, groups) {
  const mine = new Set([`sub:${sub}`, ...groups.filter((g) => (g.members ?? []).includes(sub)).map((g) => `group:${g.name}`)]);
  return grants.filter((g) => mine.has(g.who));
}

/** This person's level for one entity ({ id, area }) */
export function levelFor({ admin, grants }, entity) {
  if (admin) return 'control';
  let best = 0;
  for (const g of grants) {
    const hit = g.where === '*' || g.where === `entity:${entity.id}` || (!!entity.area && g.where === `area:${entity.area}`);
    if (hit) best = Math.max(best, rank(g.level));
  }
  return LEVELS[best];
}

export const atLeast = (level, min) => rank(level) >= rank(min);
