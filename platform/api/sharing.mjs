// Sharing one thing (a list, a section of links) with people and family groups: the rules every tool
// that shares this way keeps alike. Symlinked into each tool that uses it.
//
// The person who makes a thing owns it; nobody else sees it until the owner shares it with a person
// (`sub:<cognito sub>`) or a family group (`group:<id>`, dot-y.co/family; platform/api/people.mjs) at
// `read` or `edit`. The highest match wins. There's no admin override: what's personal stays personal.
//   none < read (see it) < edit (change it) < owner (also share it, and delete it)
// Each tool says what `edit` covers for its things.

export const LEVELS = ['none', 'read', 'edit', 'owner'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
export const atLeast = (level, min) => rank(level) >= rank(min);
const WHO = /^(sub:[0-9a-f-]{36}|group:g[a-z0-9]{8,20})$/;

/** This person's level on a thing { owner, share }. person: { sub, groupIds: Set of family group ids they're in } */
export function levelOf(person, thing) {
  if (thing.owner === person.sub) return 'owner';
  let best = 0;
  for (const s of thing.share ?? []) {
    const hit = s.who === `sub:${person.sub}` || (s.who.startsWith('group:') && person.groupIds.has(s.who.slice(6)));
    if (hit) best = Math.max(best, rank(s.level));
  }
  return LEVELS[best];
}

/** Who a thing is shared with, from input; throws with a reason */
export function parseShare(share) {
  if (!Array.isArray(share) || share.length > 20) throw new Error('share: up to 20');
  const seen = new Set();
  return share.map((s) => {
    if (!s || !WHO.test(s.who ?? '') || !['read', 'edit'].includes(s.level)) throw new Error('share: { who: sub:… or group:…, level: read or edit }');
    if (seen.has(s.who)) throw new Error('share: each person or group once');
    seen.add(s.who);
    return { who: s.who, level: s.level };
  });
}
