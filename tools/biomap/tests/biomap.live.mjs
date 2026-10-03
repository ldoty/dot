// Read-only checks against the deployed Biomap: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://biomap.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/deck'], ['GET', '/progress'], ['PUT', '/progress']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-biomap-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /deck', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('the real API code serves the published deck, and its signed photo links load', async () => {
  const { ISSUER, accessToken } = await import('../../../platform/tests/helpers/tokens.mjs');
  const { execFileSync } = await import('node:child_process');
  const bucket = execFileSync('tofu', ['-chdir=' + new URL('../infra', import.meta.url).pathname, 'output', '-raw', 'collection_bucket'], { encoding: 'utf8' }).trim();
  Object.assign(process.env, { TABLE: 'family-biomap', BUCKET: bucket, GROUP: 'lukes_biomap', ISSUER, CLIENT_ID: 'live-check' });
  const { handler } = await import('../api/api.mjs');
  const res = await handler({ routeKey: 'GET /deck', headers: { authorization: `Bearer ${accessToken({ clientId: 'live-check', group: 'lukes_biomap' })}` } });
  assert.equal(res.statusCode, 200);
  const deck = JSON.parse(res.body);
  assert.ok(deck.taxa.length > 0 && deck.cards.length > 0);
  const urls = Object.values(deck.images);
  assert.ok(urls.length > 0);
  for (const url of urls) {
    const photo = await fetch(url);
    assert.equal(photo.status, 200, 'signed photo link works');
    assert.match(photo.headers.get('content-type') || '', /image\/jpeg/);
    const unsigned = await fetch(url.split('?')[0]);
    assert.equal(unsigned.status, 403, 'the same photo without a signature is refused');
  }
});
