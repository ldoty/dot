// The sites always render in Daylight: nothing may switch to Evening from the device setting
// or a saved preference. (The style guide may still preview Evening on request.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const pages = [
  'platform/web/family.css', 'platform/web/favicon.svg',
  ...readdirSync(new URL('platform/core/portal/', root)).map((f) => `platform/core/portal/${f}`),
  'platform/templates/tool/web/index.html',
  ...readdirSync(new URL('tools/', root)).map((t) => `tools/${t}/web/index.html`).filter((p) => existsSync(new URL(p, root))),
];

for (const p of pages) {
  test(`${p} has no dark mode`, () => {
    const s = read(p);
    assert.doesNotMatch(s, /prefers-color-scheme/, 'follows the device setting');
    assert.doesNotMatch(s, /de-mode/, 'reads a saved theme');
    assert.doesNotMatch(s, /data-theme="dark"|\[data-theme="dark"\]/, 'has Evening styles');
  });
}

test('the style guide opens in Daylight', () => {
  const s = read('platform/web/style-guide.html');
  assert.doesNotMatch(s, /<style>[\s\S]*@media \(prefers-color-scheme[\s\S]*<\/style>/, 'its own styles follow the device');
  assert.match(s, /data-mode="light" aria-pressed="true"/);
});
