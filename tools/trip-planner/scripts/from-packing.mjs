#!/usr/bin/env node
// One-off: the packing list that lived at packing.dot-y.co (table family-packing) becomes the first
// trip here, Bastion and Luke's Jones Gap overnight. Copies the live row, marks and all.
// Only writes when that trip doesn't exist yet, so it's safe to re-run.
//   node tools/trip-planner/scripts/from-packing.mjs
import { execFileSync } from 'node:child_process';

const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'ldoty', AWS_REGION: 'us-east-1' };
const aws = (args) => execFileSync('aws', ['dynamodb', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const S = (v) => ({ S: v });

const old = JSON.parse(aws(['get-item', '--table-name', 'family-packing', '--key',
  JSON.stringify({ pk: S('TOOL'), sk: S('LIST#main') })])).Item;
if (!old) throw new Error('no list in family-packing');

const id = 'jones-gap-2026-11';
const item = {
  pk: S('TOOL'), sk: S(`TRIP#${id}`), id: S(id), rev: { N: '1' },
  name: S('Bastion & Luke at Jones Gap'), type: S('backpacking'), where: S('Campsite 14'),
  start: S('2026-11-14'), end: S('2026-11-15'), notes: S(''), itinerary: S(''),
  categories: old.categories, items: old.items,   // already in DynamoDB's shape
  updatedAt: S(new Date().toISOString()), updatedBy: S('from-packing'),
};
try {
  aws(['put-item', '--table-name', 'family-trip-planner', '--item', JSON.stringify(item), '--condition-expression', 'attribute_not_exists(pk)']);
  console.log(`booked ${id}: ${old.categories.L.length} categories, ${old.items.L.length} items (packing list rev ${old.rev.N})`);
} catch (e) {
  if (!String(e.stderr).includes('ConditionalCheckFailed')) throw e;
  console.log(`${id} is already here; left it alone`);
}
