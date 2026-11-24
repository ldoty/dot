// Invented drills for the tests, shaped the way scripts/upload.mjs writes them
import { fresh } from '../../../../platform/api/schedule.mjs';

const empty = '0'.repeat(81);
const at = (stones, points) => { const s = stones.split(''); for (const [i, c] of points) s[i] = String(c); return s.join(''); };
let n = 0;
export function drill(kind, extra = {}) {
  const base = { kind, size: 9, komi: 6.5, stones: at(empty, [[40, 1], [31, 2]]), toMove: 'b', last: 31, mine: false, game: 1, t: 2 };
  const by = {
    fix: { theme: 'key_point', answers: [49, 50], played: 2, loss: 5.5 },
    threat: { theme: 'threat', answers: [30], cost: 9, defense: 22, played: 70, answered: false },
    count: { theme: 'middle', lead: 3.5, own: Array(81).fill(0) },
    tsumego: { theme: 'life_and_death', prompt: 'Black to kill.', tree: { x: -1, y: -1, branches: [{ x: 2, y: 8, correct_answer: true }] } },
  }[kind];
  return { pk: `DRILL#${kind}`, sk: `d${++n}`, ...base, ...by, sched: fresh(), rev: 1, createdAt: '2026-11-01T00:00:00.000Z', ...extra };
}
