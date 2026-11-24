// KataGo's lines for the drills, to step through on the page after answering:
//   fix     best   KataGo's best sequence from the position
//           game   the move played in the game, then KataGo's best play after it
//   threat  answer KataGo's best sequence (answering the threat)
//           ignore the player to move plays elsewhere (a pass, shown as "elsewhere"), then the opponent's best line
//   count   best   best play from here, for both
// Each line is points (-1 = pass / elsewhere), at most LINE long. Cached per game in private/lines/<game>.json;
// classify.mjs puts them on the drills in private/bank.json, and upload.mjs adds them to drills already up.
//   node tools/go/scripts/lines.mjs [--visits 250]
import { existsSync, readdirSync } from 'node:fs';
import { PRIVATE, R, katago, readJson, writeJson } from './lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const VISITS = Number(arg('visits', 250));
export const LINE = 12;

const bank = readJson(`${PRIVATE}bank.json`);
if (!bank) throw new Error('no private/bank.json: run classify.mjs first');
const wanted = new Map(); // game -> Set of turns
for (const d of [...bank.fix, ...bank.threat, ...bank.count]) {
  if (!wanted.has(d.game)) wanted.set(d.game, new Set());
  wanted.get(d.game).add(d.t);
}

const pv = (info) => (info?.pv ?? []).slice(0, LINE).map((m) => R.fromGtp(m, 9));
const engine = katago();
const games = [...wanted.keys()].filter((g) => !existsSync(`${PRIVATE}lines/${g}.json`));
let done = 0;
async function one(game) {
  const a = readJson(`${PRIVATE}analysis/${game}.json`);
  const color = (t) => (t % 2 === 0 ? 'B' : 'W');
  const kmoves = a.moves.map((m, t) => [color(t), m < 0 ? 'pass' : R.gtp(m, 9)]);
  const base = { rules: a.rules, komi: a.komi, boardXSize: 9, boardYSize: 9, maxVisits: VISITS };
  const turns = [...wanted.get(game)];
  // The positions themselves, the ones just after each played move, and each one after a pass
  const after = turns.filter((t) => t + 1 <= a.moves.length).map((t) => t + 1);
  const [played, ...passed] = await Promise.all([
    engine.ask({ ...base, moves: kmoves, analyzeTurns: [...new Set([...turns, ...after])] }),
    ...turns.map((t) => engine.ask({ ...base, moves: [...kmoves.slice(0, t), [color(t), 'pass']], analyzeTurns: [t + 1] })),
  ]);
  const out = {};
  turns.forEach((t, k) => {
    const here = played.get(t), next = played.get(t + 1), pass = passed[k].get(t + 1);
    out[t] = {
      best: pv(here?.moveInfos?.[0]),
      game: next ? [a.moves[t], ...pv(next.moveInfos?.[0])].slice(0, LINE) : [a.moves[t]],
      ignore: [-1, ...pv(pass?.moveInfos?.[0])].slice(0, LINE),
    };
  });
  writeJson(`${PRIVATE}lines/${game}.json`, out);
  if (++done % 10 === 0) console.log(`${done}/${games.length}`);
}
const queue = [...games];
await Promise.all([...Array(4)].map(async () => { while (queue.length) await one(queue.shift()); }));
engine.close();
console.log(`lines for ${games.length} games (${wanted.size - games.length} already done); ${readdirSync(`${PRIVATE}lines`).length} in all`);
