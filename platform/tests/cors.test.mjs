// A page calls its API from the browser, which asks first (CORS preflight) and refuses any method the
// API doesn't allow: the request never reaches the Lambda, so nothing is logged and the page only sees
// a network error. Every method in a tool's page routes (`routes` in infra/api.tf) must be allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Methods only a server sends (no browser, no preflight), with why
const SERVER_ONLY = {
  house: ['PATCH'], // Dot's house_automation_change; the page edits with PUT
};

test('every page route’s method passes the browser’s CORS check', () => {
  let checked = 0;
  for (const tool of readdirSync(join(root, 'tools'))) {
    const file = join(root, 'tools', tool, 'infra', 'api.tf');
    if (!existsSync(file)) continue;
    const tf = readFileSync(file, 'utf8');
    const routes = /^\s*routes\s*=\s*\[([^\]]*)\]/m.exec(tf);
    const allowed = /allow_methods\s*=\s*\[([^\]]*)\]/.exec(tf);
    if (!routes || !allowed) continue;
    const methods = new Set([...allowed[1].matchAll(/"([A-Z*]+)"/g)].map((m) => m[1]));
    for (const [, method] of routes[1].matchAll(/"([A-Z]+) [^"]+"/g)) {
      if (SERVER_ONLY[tool]?.includes(method)) continue;
      assert.ok(methods.has(method) || methods.has('*'), `tools/${tool}: ${method} is a page route but CORS allows only ${[...methods].join(', ')}`);
      checked++;
    }
  }
  assert.ok(checked > 20, `checked ${checked} routes`);
});
