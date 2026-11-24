import { test } from 'node:test';
import assert from 'node:assert/strict';
import { R } from '../scripts/lib.mjs';
import { judge, drills, profile, replay } from '../scripts/classify.mjs';

const P = (s) => R.fromGtp(s, 9);
const put = (b, pts, c) => { for (const p of pts) b[P(p)] = c; return b; };

test('captures, suicide and ko', () => {
  // A white stone at A1 with black on B1: black A2 captures it
  let b = put(put(R.empty(9), ['B1'], 1), ['A1'], 2);
  const r = R.play(b, 9, P('A2'), 1, -1);
  assert.deepEqual([...r.captured], [P('A1')]);
  assert.equal(r.board[P('A1')], 0);
  // White can't play back into A1 alone: no liberties and nothing captured
  assert.equal(R.play(r.board, 9, P('A1'), 2, -1), null);
  // A ko: black takes at D5, white may not retake at once
  assert.equal(R.play(r.board, 9, P('B1'), 2, -1), null, 'a taken point');
  const b2 = put(put(R.empty(9), ['D6', 'C5', 'D4'], 1), ['E6', 'F5', 'E4', 'D5'], 2);
  const k = R.play(b2, 9, P('E5'), 1, -1);
  assert.deepEqual([...k.captured], [P('D5')]);
  const ko = R.koAfter(k.board, 9, P('E5'), k.captured);
  assert.equal(ko, P('D5'));
  assert.equal(R.play(k.board, 9, P('D5'), 2, ko), null);
  assert.ok(R.play(k.board, 9, P('D5'), 2, -1), 'legal again once the ko has moved on');
});

test('coordinates: GTP skips I, OGS letter pairs, distance', () => {
  assert.equal(R.gtp(0, 9), 'A9');
  assert.equal(R.gtp(80, 9), 'J1');
  assert.equal(P('J1'), 80);
  assert.equal(P('pass'), -1);
  assert.deepEqual(R.fromState(9, { black: 'aa', white: 'ib' }).filter(Boolean).length, 2);
  assert.equal(R.fromState(9, { black: 'aa' })[0], 1);
  assert.equal(R.fromState(9, { white: 'ib' })[9 + 8], 2);
  assert.equal(R.dist(P('A1'), P('C2'), 9), 2);
});

// An invented game: four moves, each position given a score (from Black's side), candidates and ownership
function game(over) {
  const own = () => Array(81).fill(0);
  const a = {
    id: 7, size: 9, komi: 6.5, me: 'b', moves: [P('E5'), P('E4'), P('A9'), P('D4')],
    turns: [
      { lead: 0, cands: [{ m: P('E5'), lead: 0, visits: 100 }], own: own() },
      { lead: 0, cands: [{ m: P('E4'), lead: 0, visits: 100 }], own: own() },
      // Black to play after White's E4: answering at F4 is worth far more than anything elsewhere
      { lead: 0, cands: [{ m: P('F4'), lead: 0, visits: 90 }, { m: P('C7'), lead: -6, visits: 5 }], own: own() },
      // Black played A9 and lost 8
      { lead: -8, cands: [{ m: P('D4'), lead: -8, visits: 100 }], own: own() },
      { lead: -8, cands: [], own: own() },
    ],
    passed: [null, { lead: -1, cands: [{ m: P('C3'), lead: -1, visits: 9 }] }, { lead: -9, cands: [{ m: P('F4'), lead: -9, visits: 50 }, { m: P('F5'), lead: -8.5, visits: 20 }] }, { lead: -9, cands: [] }, null],
  };
  return { ...a, ...over };
}

test('a move that ignored a nearby threat is an ignored threat, and makes a threat drill', () => {
  const a = game();
  const j = judge(a);
  assert.equal(j[2].threat, true);
  assert.equal(j[2].kind, 'ignored_threat');
  assert.equal(j[2].loss, 8);
  const d = drills(a, j);
  assert.deepEqual(d.fix.map((x) => [x.id, x.theme, x.mine, x.played]), [['7-2', 'ignored_threat', true, P('A9')]]);
  const t = d.threat.find((x) => x.t === 2);
  assert.deepEqual(t.answers.sort(), [P('F4'), P('F5')].sort(), 'White’s follow-ups within 1.5 points');
  assert.equal(t.answered, false);
  assert.equal(t.stones, replay(a.moves)[2].join(''));
  const p = profile([{ a, judged: j }]);
  assert.deepEqual(p.byKind.ignored_threat, { n: 1, points: 8 });
  assert.equal(p.moves, 2, 'only his moves count');
});

test('answering next to a move that threatened nothing, when the best was elsewhere, is a needless answer', () => {
  const a = game();
  // Same moves, but now White's E4 threatened nothing (a pass costs little) and Black answered at F4 for a loss
  a.moves = [P('E5'), P('E4'), P('F4'), P('D4')];
  a.turns[2].cands = [{ m: P('C7'), lead: 0, visits: 90 }, { m: P('F4'), lead: -4, visits: 5 }];
  a.turns[3].lead = -4;
  a.passed[2] = { lead: -1, cands: [{ m: P('F4'), lead: -1, visits: 50 }] };
  assert.equal(judge(a)[2].kind, 'needless_answer');
});

test('a move after which his stones died is lost stones', () => {
  const a = game();
  a.moves = [P('E5'), P('E4'), P('A9'), P('D4')];
  a.turns[2].cands = [{ m: P('F4'), lead: 0, visits: 90 }];
  a.passed[2] = { lead: -1, cands: [{ m: P('C3'), lead: -1, visits: 50 }] };
  // E5 (Black) was Black's before A9 and White's after
  a.turns[2].own = Array(81).fill(0); a.turns[2].own[P('E5')] = 0.9;
  a.turns[3].own = Array(81).fill(0); a.turns[3].own[P('E5')] = -0.9;
  // One stone isn't enough to call it a group: count two
  a.moves = [P('E5'), P('E4'), P('E6'), P('D4'), P('A9')];
  a.turns.splice(3, 0, { lead: 0, cands: [{ m: P('D4'), lead: 0, visits: 100 }], own: Array(81).fill(0) });
  a.passed.splice(3, 0, { lead: -1, cands: [] });
  a.turns[4] = { lead: 0, cands: [{ m: P('F4'), lead: 0, visits: 100 }], own: Array(81).fill(0) };
  a.turns[4].own[P('E5')] = 0.9; a.turns[4].own[P('E6')] = 0.9;
  a.turns[5] = { lead: -10, cands: [], own: Array(81).fill(0) };
  a.turns[5].own[P('E5')] = -0.9; a.turns[5].own[P('E6')] = -0.9;
  a.passed[4] = { lead: -2, cands: [{ m: P('C3'), lead: -2, visits: 50 }] };
  a.passed[5] = null;
  const j = judge(a);
  assert.equal(j[4].kind, 'lost_stones');
});

test('progress: a change counts as real only past twice its standard error, and only on 10+ games', async () => {
  const { stats, compare } = await import('../scripts/progress.mjs');
  assert.deepEqual(stats([1, 2, 3]), { mean: 2, sd: 1, games: 3 });
  const before = { mean: 1.08, sd: 1.6, games: 198 };
  assert.equal(compare(before, { mean: 0.4, sd: 0.8, games: 40 }).real, true);
  assert.equal(compare(before, { mean: 0.9, sd: 1.5, games: 40 }).real, false, 'within the noise');
  assert.equal(compare(before, { mean: 0, sd: 0, games: 5 }).real, false, 'too few games');
  assert.equal(compare(before, { mean: 0.4, sd: 0.8, games: 40 }).change, -0.68);
});
