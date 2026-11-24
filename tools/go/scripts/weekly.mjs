// The weekly refresh: his newest games from OGS through KataGo and into the tool, so the program's
// real-games chart shows whether the drills are working.
//   node tools/go/scripts/weekly.mjs [--games 60]
// Games already analysed are skipped (analyze.mjs and lines.mjs cache per game), so a week's run only does
// the new ones. Needs KataGo (brew install katago) and fresh `ldoty` credentials for the upload.
import { spawnSync } from 'node:child_process';

const i = process.argv.indexOf('--games');
const games = i > 0 ? process.argv[i + 1] : '60';
const dir = new URL('.', import.meta.url).pathname;
for (const [script, ...args] of [['analyze.mjs', '--games', games], ['classify.mjs'], ['lines.mjs'], ['classify.mjs'], ['upload.mjs']]) {
  console.log(`\n== ${script}`);
  const r = spawnSync(process.execPath, [`${dir}${script}`, ...args], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${script} failed (${r.status})`); process.exit(r.status ?? 1); }
}
