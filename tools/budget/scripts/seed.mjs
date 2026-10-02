#!/usr/bin/env node
// Loads the household's data into the family-budget table.
//
//   node scripts/seed.mjs                 DEFAULTS (Reset target) from project_pax/household-budget.html if missing;
//                                         any missing working doc (shared, Luke, Amber) from the legacy
//                                         combined STATE row if present, else from DEFAULTS; and, if no
//                                         "default" tag exists, a "Starting point" Shared version tagged default
//   node scripts/seed.mjs --import FILE   also overwrite the three docs and add saved versions from a browser
//                                         export, e.g. the old file:// page's localStorage
//
// The starting numbers are computed with the original page's own normalize() and
// defaultPeople(), so they match what that page showed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ORIGINAL = join(here, '../../../private/project_pax/household-budget.html');
const TABLE = 'family-budget';
const PK = 'HOUSEHOLD#luke-amber';
const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'ldoty', AWS_REGION: 'us-east-1' };

function aws(...args) {
  return execFileSync('aws', ['dynamodb', ...args, '--table-name', TABLE, '--output', 'json'], { env, encoding: 'utf8' });
}
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });

function get(sk) {
  const out = execFileSync('aws', ['dynamodb', 'get-item', '--table-name', TABLE, '--output', 'json',
    '--key', JSON.stringify({ pk: S(PK), sk: S(sk) })], { env, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out).Item : undefined;
}

// One combined budget -> { shared, Luke, Amber }, matching the page's splitCombined()
const PEOPLE = ['Luke', 'Amber'];
function split(d) {
  const out = { shared: { categories: d.categories, mortgage: d.mortgage, split: d.split } };
  for (const p of PEOPLE) out[p] = { ...(d.people?.[p] ?? { income: [], categories: [] }), follows: 'default' };
  return out;
}
const docKey = (doc) => `DOC#${doc}#STATE`;
const uid = () => 'x' + Math.random().toString(36).slice(2, 9);

function put(item, condition) {
  const args = ['put-item', '--item', JSON.stringify(item)];
  if (condition) args.push('--condition-expression', condition);
  try {
    aws(...args);
    return true;
  } catch (e) {
    if (String(e.stderr).includes('ConditionalCheckFailed')) return false;
    throw e;
  }
}

// --- Starting numbers from the original page -----------------------------------
const html = readFileSync(ORIGINAL, 'utf8');
const data = JSON.parse(/<script type="application\/json" id="budget-data">(.*?)<\/script>/s.exec(html)[1]);
const js = /<script id="app-js">(.*?)<\/script>/s.exec(html)[1];
const pick = (re) => { const m = re.exec(js); if (!m) throw new Error(`not found: ${re}`); return m[0]; };
const fns = [
  pick(/var PEOPLE = .*?;/),
  pick(/var INSURANCE_PCT = .*?;/),
  pick(/function mk\(.*?\n  \}\n/s),
  pick(/function share\(.*?\}\n/),
  pick(/function defaultPeople\(\) \{.*?\n  \}\n/s),
  pick(/function normalize\(d\) \{.*?\n  \}\n/s),
].join('\n');
const normalize = new Function(`${fns}\nreturn normalize;`)();
const defaults = normalize(data);
delete defaults.updated;

// Only when missing, so later edits to the starting numbers (e.g. the Greer tax rate) survive re-runs
console.log(put({ pk: S(PK), sk: S('DEFAULTS'), state: S(JSON.stringify(defaults)) }, 'attribute_not_exists(pk)')
  ? 'DEFAULTS written' : 'DEFAULTS already exist, left as is');

// --- Working docs -------------------------------------------------------------
const legacy = get('STATE');
const source = legacy ? JSON.parse(legacy.state.S) : defaults;
const docs = split(source);
for (const [doc, st] of Object.entries(docs)) {
  const ok = put({ pk: S(PK), sk: S(docKey(doc)), state: S(JSON.stringify(st)), rev: N(1), updatedBy: S('seed') }, 'attribute_not_exists(pk)');
  console.log(ok ? `${doc}: created from ${legacy ? 'legacy STATE' : 'DEFAULTS'}` : `${doc}: already exists, left as is`);
}

// --- default tag ---------------------------------------------------------------
if (!get('TAG#default')) {
  const shared = JSON.parse(get(docKey('shared')).state.S);
  delete shared.version; delete shared.edited; delete shared.updated;
  const id = uid();
  put({ pk: S(PK), sk: S(`DOC#shared#VERSION#${id}`), name: S('Starting point'), savedAt: N(Date.now()), state: S(JSON.stringify(shared)), updatedBy: S('seed') });
  put({ pk: S(PK), sk: S('TAG#default'), versionId: S(id), updatedBy: S('seed') });
  console.log(`Shared version "Starting point" (${id}) tagged default`);
} else {
  console.log('default tag already exists, left as is');
}

// --- Import from a browser export ----------------------------------------------
const i = process.argv.indexOf('--import');
if (i > 0) {
  const exp = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
  if (exp.state) {
    // A fresh rev makes any open page reload these on its next save.
    for (const [doc, st] of Object.entries(split(normalize(exp.state)))) {
      put({ pk: S(PK), sk: S(docKey(doc)), state: S(JSON.stringify(st)), rev: N(Date.now()), updatedBy: S('import') });
    }
    console.log('docs imported');
  }
  // Each old combined version becomes a version of the same name in all three docs
  for (const v of exp.versions || []) {
    for (const [doc, st] of Object.entries(split(normalize(v.state)))) {
      put({ pk: S(PK), sk: S(`DOC#${doc}#VERSION#${v.id}`), name: S(v.name), savedAt: N(v.savedAt || Date.now()), state: S(JSON.stringify(st)), updatedBy: S('import') });
    }
    console.log(`version imported: ${v.name}`);
  }
}
