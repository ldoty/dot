// Every Lambda zipped from source (archive_file in a root's infra/*.tf) must carry every file its code
// imports: a missing one deploys fine and fails on the first request. Bundled Lambdas (api/dist/) are
// esbuild's job and skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [
  ...readdirSync(join(root, 'tools')).map((t) => join(root, 'tools', t, 'infra')),
  ...readdirSync(join(root, 'platform')).map((p) => join(root, 'platform', p, 'infra')),
  join(root, 'platform/core'),
].filter(existsSync);

test('every zipped Lambda has every file it imports', () => {
  let checked = 0;
  for (const dir of roots) {
    for (const tf of readdirSync(dir).filter((f) => f.endsWith('.tf'))) {
      const text = readFileSync(join(dir, tf), 'utf8');
      for (const block of text.split(/data "archive_file"/).slice(1)) {
        const body = block.slice(0, block.search(/\n}\n/) + 1);
        const files = new Map([...body.matchAll(/content\s*=\s*file\("\$\{path\.module\}\/([^"]+)"\)\s*filename\s*=\s*"([^"]+)"/g)].map((m) => [m[2], join(dir, m[1])]));
        for (const [name, path] of files) {
          if (!name.endsWith('.mjs') || path.includes('/dist/')) continue;
          for (const [, dep] of readFileSync(path, 'utf8').matchAll(/(?:from |import\()'\.\/([\w.-]+\.mjs)'/g)) {
            assert.ok(files.has(dep), `${dir.slice(root.length + 1)}/${tf}: ${name} imports ./${dep}, which isn't in its zip`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 20, `checked ${checked} files`);
});
