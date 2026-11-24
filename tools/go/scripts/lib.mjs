// What the Go scripts share: the page's rules (web/rules.js, run in a vm so there's one copy), OGS reads
// (slow and cached: it's someone else's free service) and KataGo's analysis engine.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import vm from 'node:vm';

export const ROOT = new URL('..', import.meta.url).pathname;
export const PRIVATE = `${ROOT}private/`;

const ctx = {};
vm.runInNewContext(readFileSync(`${ROOT}web/rules.js`, 'utf8'), ctx);
export const R = ctx.GoRules;

// ---- OGS: one request at a time, at most one a second, every answer cached on disk ----
const OGS = 'https://online-go.com/api/v1';
let last = 0;
export async function ogs(path, { cache = true } = {}) {
  const file = `${PRIVATE}ogs/${path.replace(/[^a-z0-9]+/gi, '_')}.json`;
  if (cache && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(path.startsWith('http') ? path : OGS + path, { headers: { 'user-agent': 'go-study-trainer/1.0 (personal use)' } });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`OGS ${res.status} ${path}`);
    const body = await res.json();
    if (cache) { mkdirSync(`${PRIVATE}ogs`, { recursive: true }); writeFileSync(file, JSON.stringify(body)); }
    return body;
  }
}

// ---- KataGo's analysis engine: JSON queries in, one answer per analysed turn out ----
export function katago({ threads = 24, searchThreads = 2 } = {}) {
  const prefix = execSync('brew --prefix katago').toString().trim();
  const share = `${prefix}/share/katago`;
  const model = `${share}/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`;
  mkdirSync(`${PRIVATE}katago-logs`, { recursive: true });
  const proc = spawn('katago', ['analysis', '-config', `${share}/configs/analysis_example.cfg`, '-model', model, '-override-config',
    `reportAnalysisWinratesAs=BLACK,logDir=${PRIVATE}katago-logs,numAnalysisThreads=${threads},numSearchThreadsPerAnalysisThread=${searchThreads}`],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const d = JSON.parse(line);
    const p = pending.get(d.id);
    if (!p) return;
    if (d.error) { pending.delete(d.id); p.reject(new Error(`katago: ${d.error}`)); return; }
    if (d.warning) return;
    p.got.set(d.turnNumber, d);
    if (p.got.size === p.want) { pending.delete(d.id); p.resolve(p.got); }
  });
  let n = 0;
  return {
    /** -> Map(turnNumber -> answer) for every turn in query.analyzeTurns (or the last one) */
    ask(query) {
      const id = `q${n++}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, got: new Map(), want: query.analyzeTurns?.length ?? 1 });
        proc.stdin.write(`${JSON.stringify({ ...query, id })}\n`);
      });
    },
    close: () => { proc.stdin.end(); },
  };
}

export const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
export const writeJson = (f, v) => { mkdirSync(f.replace(/[^/]+$/, ''), { recursive: true }); writeFileSync(f, JSON.stringify(v)); };
