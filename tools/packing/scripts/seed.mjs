#!/usr/bin/env node
// Load the packing list kept in private/packing_list.json (real data, gitignored) into the table.
// Only writes when the table has no list yet, so it never overwrites edits made on the site.
//   node tools/packing/scripts/seed.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'ldoty', AWS_REGION: 'us-east-1' };
const list = JSON.parse(readFileSync(new URL('../private/packing_list.json', import.meta.url), 'utf8'));
const S = (v) => ({ S: String(v) });
const item = {
  pk: S('TOOL'), sk: S('LIST#main'), rev: { N: '1' },
  categories: { L: list.categories.map((c) => ({ M: { id: S(c.id), name: S(c.name) } })) },
  items: { L: list.items.map((i) => ({ M: { id: S(i.id), text: S(i.text), categoryId: S(i.categoryId), status: S(i.status || '') } })) },
  updatedAt: S(new Date().toISOString()), updatedBy: S('seed'),
};

try {
  execFileSync('aws', ['dynamodb', 'put-item', '--table-name', 'family-packing', '--item', JSON.stringify(item),
    '--condition-expression', 'attribute_not_exists(pk)'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`loaded ${list.categories.length} categories, ${list.items.length} items`);
} catch (e) {
  if (!String(e.stderr).includes('ConditionalCheckFailed')) throw e;
  console.log('the table already has a list; left it alone');
}
