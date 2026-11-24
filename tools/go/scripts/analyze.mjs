// Analyse a player's recent 9x9 games with KataGo, for the error database and the drill bank.
//   node tools/go/scripts/analyze.mjs [--player 1881624] [--games 200] [--visits 120]
// Each game is fetched from OGS once (cached), then every position gets two searches:
//   as played  the score with best play from here (rootInfo.scoreLead, from Black's side), the best moves
//              and who owns each point
//   passed     the same position after the player to move passes: what the opponent would do with a free
//              move, and what that costs (how big the threat on the board is)
// Results go to private/analysis/<game>.json; classify.mjs turns them into mistakes and drills.
import { PRIVATE, R, katago, ogs, writeJson } from './lib.mjs';
import { existsSync } from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const PLAYER = Number(arg('player', 1881624));
const GAMES = Number(arg('games', 200));
const VISITS = Number(arg('visits', 120));
const RULES = { japanese: 'japanese', chinese: 'chinese', aga: 'aga', korean: 'korean', nz: 'new-zealand', ing: 'chinese' };

async function recentGames() {
  const out = [];
  let next = `/players/${PLAYER}/games/?width=9&height=9&ordering=-ended&page_size=50`;
  while (next && out.length < GAMES) {
    const page = await ogs(next, { cache: false });
    for (const g of page.results) {
      if (!g.ended || g.annulled || g.handicap || g.width !== 9 || g.height !== 9) continue;
      out.push(g.id);
      if (out.length >= GAMES) break;
    }
    next = page.next;
  }
  return out;
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const cands = (d, n) => d.moveInfos.slice(0, n).map((m) => ({ m: R.fromGtp(m.move, 9), lead: round(m.scoreLead), visits: m.visits }));

async function analyse(engine, id) {
  const g = await ogs(`/games/${id}`);
  const gd = g.gamedata;
  if (gd.initial_state && (gd.initial_state.black || gd.initial_state.white)) return null;
  const moves = gd.moves.map((m) => (m[0] < 0 ? -1 : m[1] * 9 + m[0]));
  if (moves.length < 16) return null;
  const color = (t) => (t % 2 === 0 ? 'B' : 'W');
  const kmoves = moves.map((m, t) => [color(t), m < 0 ? 'pass' : R.gtp(m, 9)]);
  const base = { rules: RULES[gd.rules] ?? 'japanese', komi: gd.komi, boardXSize: 9, boardYSize: 9 };
  const turns = [...Array(moves.length + 1).keys()];
  const [played, ...passed] = await Promise.all([
    engine.ask({ ...base, moves: kmoves, analyzeTurns: turns, maxVisits: VISITS, includeOwnership: true }),
    ...turns.slice(1, -1).map((t) => engine.ask({ ...base, moves: [...kmoves.slice(0, t), [color(t), 'pass']], analyzeTurns: [t + 1], maxVisits: Math.round(VISITS / 2) })),
  ]);
  const me = g.players.black.id === PLAYER ? 'b' : g.players.white.id === PLAYER ? 'w' : null;
  return {
    id, size: 9, komi: gd.komi, rules: base.rules, me, ended: g.ended, outcome: g.outcome,
    winner: g.black_lost && !g.white_lost ? 'w' : g.white_lost && !g.black_lost ? 'b' : null,
    players: { b: { name: g.players.black.username, rank: round(g.players.black.ranking ?? 0, 1) }, w: { name: g.players.white.username, rank: round(g.players.white.ranking ?? 0, 1) } },
    moves,
    turns: turns.map((t) => {
      const d = played.get(t);
      return { lead: round(d.rootInfo.scoreLead), cands: cands(d, 10), own: d.ownership.map((o) => round(o)) };
    }),
    // passed[t]: position t after the player to move passed (none for the first and last positions)
    passed: turns.map((t) => {
      if (t === 0 || t === moves.length) return null;
      const d = passed[t - 1].get(t + 1);
      return { lead: round(d.rootInfo.scoreLead), cands: cands(d, 6) };
    }),
  };
}

const ids = await recentGames();
console.log(`${ids.length} games to analyse`);
const engine = katago();
let done = 0, skipped = 0;
const queue = ids.filter((id) => !existsSync(`${PRIVATE}analysis/${id}.json`));
done = ids.length - queue.length;
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    try {
      const a = await analyse(engine, id);
      if (a) writeJson(`${PRIVATE}analysis/${id}.json`, a); else skipped++;
    } catch (e) {
      console.warn(`game ${id}: ${e.message}`);
      skipped++;
    }
    done++;
    if (done % 10 === 0) console.log(`${done}/${ids.length} (${skipped} skipped)`);
  }
}
await Promise.all([...Array(6)].map(worker));
engine.close();
writeJson(`${PRIVATE}analysis/index.json`, { player: PLAYER, games: ids, at: new Date().toISOString() });
console.log(`done: ${done} games, ${skipped} skipped`);
