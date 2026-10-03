#!/usr/bin/env node
// Starting content for Links: a Technology section with the UniFi console.
// Safe to re-run: it only adds rows that don't exist yet.
//   node tools/links/scripts/seed.mjs
import { execFileSync } from 'node:child_process';

const env = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'ldoty', AWS_REGION: 'us-east-1' };
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });

function putIfMissing(item) {
  try {
    execFileSync('aws', ['dynamodb', 'put-item', '--table-name', 'family-links', '--item', JSON.stringify(item),
      '--condition-expression', 'attribute_not_exists(pk)'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (e) {
    if (String(e.stderr).includes('ConditionalCheckFailed')) return false;
    throw e;
  }
}

const stamp = { updatedAt: S(new Date().toISOString()), updatedBy: S('seed') };
console.log(putIfMissing({ pk: S('TOOL'), sk: S('SECTION#technology'), name: S('Technology'), order: N(1), ...stamp })
  ? 'section Technology added' : 'section Technology already exists');
console.log(putIfMissing({ pk: S('TOOL'), sk: S('LINK#unifi'), sectionId: S('technology'), title: S('UniFi'), url: S('https://unifi.ui.com/'), order: N(1), ...stamp })
  ? 'link UniFi added' : 'link UniFi already exists');
