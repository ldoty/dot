// Is the training working? Compares his real games since the baseline with the games before it.
//   node tools/go/scripts/progress.mjs --baseline   record the baseline (once, when training starts):
//                                                   private/baseline.json, from every game analysed so far
//   node tools/go/scripts/progress.mjs              games played since, against it (run weekly.mjs first)
//
// For each kind of mistake: how often a game and points lost a game, before and since. A change counts as
// real only when it's more than twice its standard error (Welch: the spread of each side's per-game numbers
// over the square root of its games); anything smaller is noise. Points are noisy (one dead group is 40),
// so how often is the measure to watch; points follow. His OGS rank is printed too: win rate isn't a
// measure (OGS pairs him with players his rank), but the rank is.
import { readdirSync } from 'node:fs';
import { KINDS, judge } from './classify.mjs';
import { PRIVATE, ogs, readJson, writeJson } from './lib.mjs';

const PLAYER = 1881624;
const FILE = `${PRIVATE}baseline.json`;

/** Per game: { ended, n: { kind: count }, points: { kind: points } }, with `all` for every kind together */
function perGame() {
  return readdirSync(`${PRIVATE}analysis`).filter((f) => /^\d+\.json$/.test(f)).map((f) => readJson(`${PRIVATE}analysis/${f}`))
    .filter((a) => a.me && a.ended).map((a) => {
      const me = a.me === 'b' ? 1 : 2, n = { all: 0 }, points = { all: 0 };
      for (const k of KINDS) { n[k] = 0; points[k] = 0; }
      for (const j of judge(a)) if (j.color === me && j.kind) { n[j.kind]++; n.all++; points[j.kind] += j.loss; points.all += j.loss; }
      return { ended: a.ended, n, points };
    });
}

/** mean, sd and count of a list */
export function stats(v) {
  const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : 0;
  return { mean: Math.round(m * 100) / 100, sd: Math.round(sd * 100) / 100, games: v.length };
}

/** Is `after` really different from `before`? -> { change, se, real } (real: more than 2 standard errors) */
export function compare(before, after) {
  const se = Math.sqrt(before.sd ** 2 / before.games + after.sd ** 2 / after.games);
  const change = after.mean - before.mean;
  return { change: Math.round(change * 100) / 100, se: Math.round(se * 100) / 100, real: after.games >= 10 && Math.abs(change) > 2 * se };
}

async function rank() {
  try { return (await ogs(`/players/${PLAYER}/`, { cache: false })).ranking; } catch { return null; }
}
const kyu = (r) => (r == null ? '?' : r >= 30 ? `${Math.floor(r - 29)}d` : `${(30 - r).toFixed(1)}k`);

if (import.meta.url === `file://${process.argv[1]}`) {
  const games = perGame();
  if (process.argv.includes('--baseline')) {
    const out = { at: new Date().toISOString(), games: games.length, from: games.map((g) => g.ended).sort()[0], rank: await rank(), kinds: {} };
    for (const k of ['all', ...KINDS]) out.kinds[k] = { n: stats(games.map((g) => g.n[k])), points: stats(games.map((g) => g.points[k])) };
    writeJson(FILE, out);
    console.log(`baseline: ${out.games} games to ${out.at.slice(0, 10)}, rank ${kyu(out.rank)} -> private/baseline.json`);
    process.exit(0);
  }

  const base = readJson(FILE);
  if (!base) throw new Error('no baseline: run with --baseline first');
  const since = games.filter((g) => g.ended > base.at);
  const now = await rank();
  console.log(`Since ${base.at.slice(0, 10)}: ${since.length} games (baseline ${base.games}). Rank ${kyu(base.rank)} -> ${kyu(now)}.`);
  if (since.length < 10) console.log('Fewer than 10 games since: too early to tell anything.');
  console.log(`\n${'kind'.padEnd(16)} ${'a game: before → since'.padEnd(26)} ${'points a game: before → since'.padEnd(32)} verdict`);
  for (const k of ['all', ...KINDS]) {
    const b = base.kinds[k];
    const an = stats(since.map((g) => g.n[k])), ap = stats(since.map((g) => g.points[k]));
    const cn = compare(b.n, an), cp = compare(b.points, ap);
    const verdict = !since.length ? '' : cn.real ? (cn.change < 0 ? 'better (real)' : 'worse (real)') : cp.real ? (cp.change < 0 ? 'fewer points (real)' : 'more points (real)') : 'no clear change';
    console.log(`${k.padEnd(16)} ${`${b.n.mean.toFixed(2)} → ${since.length ? an.mean.toFixed(2) : '–'}`.padEnd(26)} ${`${b.points.mean.toFixed(1)} → ${since.length ? ap.mean.toFixed(1) : '–'}`.padEnd(32)} ${verdict}`);
  }
}
