// Turns analysed games (analyze.mjs) into the error database and the drill bank.
//   node tools/go/scripts/classify.mjs            -> private/bank.json, and prints the player's mistakes by kind
//
// A move is a mistake when it lost at least MISTAKE points against KataGo's best (its score with best play
// before the move, minus after). Each mistake gets the first kind that fits:
//   ignored_threat   the opponent's last move threatened something big nearby (passing would cost ≥ THREAT
//                    points and their follow-up is next to it), and the move went somewhere else
//   lost_stones      stones that were alive before the move are dead after it (cut off, captured, killed)
//   missed_kill      opponent stones that were dead with best play live after the move
//   needless_answer  nothing was threatened, the move answered next to the opponent's last move anyway, and
//                    the best move was elsewhere: gote where tenuki was bigger
//   endgame          late in the game, a smaller loss: the wrong order or the wrong size of endgame move
//   key_point        the best move was elsewhere, on a point touching both colours: the cut, the connection or
//                    the point between your stones and theirs that decides which group is weak
//   wrong_area       the best move was somewhere else on the board (direction, the biggest point)
//   local_shape      the right area, the wrong move (shape, reading)
// The same positions give the drills: every mistake (the player's and their opponents') becomes "find the
// better move", every real threat "where's the threat?", and quiet middle-game positions "who's ahead?".
import { readdirSync } from 'node:fs';
import { PRIVATE, R, readJson, writeJson } from './lib.mjs';

export const MISTAKE = 3;     // points lost
export const THREAT = 5;      // points a pass would cost
export const DECIDED = 20;    // past this lead the game is over; mistakes stop counting
export const URGENT = 3;      // points the best local answer must beat the best move elsewhere by, to be urgent
export const KINDS = ['ignored_threat', 'lost_stones', 'missed_kill', 'needless_answer', 'key_point', 'endgame', 'wrong_area', 'local_shape'];

/** Does point i touch stones of both colours (orthogonally)? */
const between = (board, size, i) => {
  const seen = new Set(R.neighbors(i, size).map((n) => board[n]));
  return seen.has(1) && seen.has(2);
};

/** The board before each move: boards[t], with captures */
export function replay(moves, size = 9) {
  const boards = [R.empty(size)];
  let ko = -1;
  moves.forEach((m, t) => {
    const b = boards[t];
    if (m < 0) { boards.push(b); ko = -1; return; }
    const r = R.play(b, size, m, t % 2 === 0 ? 1 : 2, ko);
    if (!r) { boards.push(b); ko = -1; return; } // (an illegal record: leave the board)
    ko = R.koAfter(r.board, size, m, r.captured);
    boards.push(r.board);
  });
  return boards;
}

/** Points whose owner flips for `sign`'s stones of `color` on `board`: owned ≥ .4 before, ≤ -.4 after */
const flipped = (board, color, before, after, sign) => board.reduce((n, c, i) => n + (c === color && sign * before[i] >= 0.4 && sign * after[i] <= -0.4 ? 1 : 0), 0);

/** Every move of a game, judged. -> [{ t, color, sign, move, best, loss, threat, kind? }] */
export function judge(a) {
  const size = a.size, boards = replay(a.moves, size), out = [];
  const endgameFrom = Math.max(30, Math.round(a.moves.length * 0.6));
  for (let t = 0; t < a.moves.length; t++) {
    const color = t % 2 === 0 ? 1 : 2, sign = color === 1 ? 1 : -1;
    const now = a.turns[t], next = a.turns[t + 1], move = a.moves[t], last = t > 0 ? a.moves[t - 1] : -1;
    const best = now.cands[0]?.m ?? -1;
    const loss = Math.round(sign * (now.lead - next.lead) * 10) / 10;
    const passed = a.passed[t];
    const passCost = passed ? sign * (now.lead - passed.lead) : 0;
    const follow = passed?.cands[0]?.m ?? -1;
    const local = (p) => p >= 0 && last >= 0 && R.dist(p, last, size) <= 2;
    // Urgent: the best answer next to the opponent's last move beats the best move anywhere else by URGENT
    // (or nothing elsewhere was even worth searching), and their follow-up after a pass is right there too.
    // A pass alone isn't the test: in the opening, any pass costs a lot.
    const near = now.cands.find((c) => local(c.m)), far = now.cands.find((c) => c.m >= 0 && !local(c.m));
    const urgency = near ? (far ? sign * (near.lead - far.lead) : passCost) : 0;
    const threat = !!passed && last >= 0 && passCost >= THREAT && local(follow) && !!near && urgency >= URGENT;
    const j = { t, color, sign, move, best, last, loss, lead: sign * now.lead, passCost: Math.round(passCost * 10) / 10, urgency: Math.round(urgency * 10) / 10, threat, follow, board: boards[t] };
    if (loss >= MISTAKE && Math.abs(now.lead) < DECIDED && move >= 0) {
      const away = (p) => p < 0 || move < 0 || R.dist(move, p, size) > 2;
      if (threat && away(last) && away(follow)) j.kind = 'ignored_threat';
      else if (flipped(boards[t], color, now.own, next.own, sign) >= 2) j.kind = 'lost_stones';
      else if (flipped(boards[t], 3 - color, now.own, next.own, -sign) >= 2) j.kind = 'missed_kill';
      else if (!threat && local(move) && best >= 0 && !local(best) && urgency <= -2) j.kind = 'needless_answer';
      else if (best >= 0 && R.dist(move, best, size) > 2 && between(boards[t], size, best)) j.kind = 'key_point';
      else if (t >= endgameFrom && loss < 8) j.kind = 'endgame';
      else if (best >= 0 && R.dist(move, best, size) > 2) j.kind = 'wrong_area';
      else j.kind = 'local_shape';
    }
    out.push(j);
  }
  return out;
}

const stones = (b) => b.join('');
/** Good answers in a position: every candidate within `within` points of the best, for `sign` */
const goodMoves = (cands, sign, within) => {
  if (!cands.length) return [];
  const top = sign * cands[0].lead;
  return cands.filter((c, i) => c.m >= 0 && (i === 0 || (sign * c.lead >= top - within && c.visits >= 5))).map((c) => c.m);
};

/** A game's drills: { fix: [...], threat: [...], count: [...] } */
export function drills(a, judged = judge(a)) {
  const me = a.me === 'b' ? 1 : a.me === 'w' ? 2 : 0;
  const base = (j) => ({ game: a.id, t: j.t, size: a.size, komi: a.komi, stones: stones(j.board), toMove: j.color === 1 ? 'b' : 'w', last: j.last, mine: j.color === me });
  const fix = judged.filter((j) => j.kind).map((j) => ({
    kind: 'fix', id: `${a.id}-${j.t}`, ...base(j), theme: j.kind, answers: goodMoves(a.turns[j.t].cands, j.sign, 1), played: j.move, loss: j.loss,
  }));
  const threat = judged.filter((j) => j.threat).map((j) => ({
    kind: 'threat', id: `${a.id}-${j.t}`, ...base(j), theme: 'threat', answers: goodMoves(a.passed[j.t].cands, -j.sign, 1.5),
    cost: j.passCost, defense: j.best, played: j.move, answered: j.move >= 0 && (R.dist(j.move, j.last, a.size) <= 2 || R.dist(j.move, j.follow, a.size) <= 2),
  }));
  // Quiet middle-game positions, a couple a game, for counting: nothing urgent, the game still close
  const quiet = judged.filter((j) => j.t >= 14 && j.t <= Math.min(a.moves.length - 6, 45) && !j.threat && j.passCost < 8 && Math.abs(a.turns[j.t].lead) <= 15);
  const count = [];
  for (const j of quiet) {
    if (count.length >= 3 || count.some((c) => Math.abs(c.t - j.t) < 8)) continue;
    count.push({ kind: 'count', id: `${a.id}-${j.t}`, ...base(j), theme: j.t < 28 ? 'middle' : 'late', lead: a.turns[j.t].lead, own: a.turns[j.t].own.map((o) => Math.round(o * 100)) });
  }
  return { fix, threat, count };
}

/** The lines a drill shows, by kind, from a position's lines (lines.mjs: best, game, ignore) */
export function linesFor(kind, l) {
  if (kind === 'fix') return { best: l.best, game: l.game };
  if (kind === 'threat') return { answer: l.best, ignore: l.ignore };
  return { best: l.best };
}

/** The player's mistakes by kind: { [kind]: { n, points } }, plus games and moves seen */
export function profile(games) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { n: 0, points: 0 }]));
  let moves = 0;
  for (const { a, judged } of games) {
    const me = a.me === 'b' ? 1 : 2;
    for (const j of judged) {
      if (j.color !== me) continue;
      moves++;
      if (j.kind) { byKind[j.kind].n++; byKind[j.kind].points = Math.round((byKind[j.kind].points + j.loss) * 10) / 10; }
    }
  }
  return { games: games.length, moves, byKind };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(`${PRIVATE}analysis`).filter((f) => /^\d+\.json$/.test(f));
  const games = files.map((f) => readJson(`${PRIVATE}analysis/${f}`)).filter((a) => a.me).map((a) => ({ a, judged: judge(a) }));
  const bank = { fix: [], threat: [], count: [] };
  for (const g of games) { const d = drills(g.a, g.judged); for (const k of Object.keys(bank)) bank[k].push(...d[k]); }
  // KataGo's lines (lines.mjs), where they've been worked out, to step through after answering
  for (const k of Object.keys(bank)) for (const d of bank[k]) {
    const l = readJson(`${PRIVATE}lines/${d.game}.json`, {})[d.t];
    if (l) d.lines = linesFor(d.kind, l);
  }
  const p = profile(games);
  writeJson(`${PRIVATE}bank.json`, { at: new Date().toISOString(), profile: p, ...bank });
  console.log(`${p.games} games, ${p.moves} of your moves`);
  const total = KINDS.reduce((n, k) => n + p.byKind[k].points, 0);
  for (const k of [...KINDS].sort((x, y) => p.byKind[y].points - p.byKind[x].points)) {
    const { n, points } = p.byKind[k];
    console.log(`${k.padEnd(16)} ${String(n).padStart(4)} mistakes  ${String(points).padStart(7)} points  ${Math.round(100 * points / (total || 1))}%  (${(n / p.games).toFixed(2)} a game)`);
  }
  console.log(`drills: ${bank.fix.length} fix (${bank.fix.filter((d) => d.mine).length} yours), ${bank.threat.length} threat, ${bank.count.length} count`);
}
