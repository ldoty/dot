// Read-only checks against the deployed assistant: `npm run test:live`. Never calls Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SITE = 'https://assistant.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('the function URL refuses requests without a token (checked by the function itself)', async () => {
  for (const [method, path] of [['GET', '/conversations'], ['POST', '/chat'], ['DELETE', '/conversations/x1']]) {
    const res = await fetch(config.apiUrl + path, { method, body: method === 'POST' ? '{"text":"hi"}' : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('CORS allows only the assistant site', async () => {
  const pre = (origin) => fetch(`${config.apiUrl}/chat`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal((await pre(SITE)).headers.get('access-control-allow-origin'), SITE);
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
});

test('the page is served', async () => {
  const res = await fetch(`${SITE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Dot<\/title>/);
});
