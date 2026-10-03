import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, call, table } from './helpers/links-api.mjs';

beforeEach(async () => {
  table.clear();
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1 });
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/all', undefined, null)).status, 401);
  assert.equal((await call('GET', '/all', undefined, forgedToken({ clientId: CLIENT_ID, group: 'family_links' }))).status, 401);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: CLIENT_ID, group: 'family_budget' }))).status, 403);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: 'budget-client', group: 'family_links' }))).status, 401);
});

test('sections and links round-trip, in order', async () => {
  await call('PUT', '/links/l2', { sectionId: 'tech', url: 'https://example.com/b', title: 'B', order: 2 });
  await call('PUT', '/links/l1', { sectionId: 'tech', url: 'https://unifi.ui.com/', title: 'UniFi', order: 1 });
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.sections, [{ id: 'tech', name: 'Technology', order: 1 }]);
  assert.deepEqual(body.links.map((l) => l.title), ['UniFi', 'B']);
});

test('only http(s) links are accepted', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url', '']) {
    assert.equal((await call('PUT', '/links/x', { sectionId: 'tech', url })).status, 400, url);
  }
  assert.equal((await call('PUT', '/links/x', { sectionId: 'tech', url: 'http://router.local/' })).status, 200);
});

test('a link needs an existing section; the title defaults to the host', async () => {
  assert.equal((await call('PUT', '/links/x', { sectionId: 'nope', url: 'https://a.com' })).status, 400);
  const r = await call('PUT', '/links/x', { sectionId: 'tech', url: 'https://unifi.ui.com/' });
  assert.equal(r.body.title, 'unifi.ui.com');
});

test('deleting a section deletes its links, and only its links', async () => {
  await call('PUT', '/sections/home', { name: 'Home', order: 2 });
  await call('PUT', '/links/a', { sectionId: 'tech', url: 'https://a.com' });
  await call('PUT', '/links/b', { sectionId: 'home', url: 'https://b.com' });
  assert.equal((await call('DELETE', '/sections/tech')).status, 200);
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.sections.map((s) => s.id), ['home']);
  assert.deepEqual(body.links.map((l) => l.id), ['b']);
});

test('validates names and ids', async () => {
  assert.equal((await call('PUT', '/sections/s1', { name: '  ' })).status, 400);
  assert.equal((await call('PUT', '/sections/bad%20id', { name: 'x' })).status, 400);
});
