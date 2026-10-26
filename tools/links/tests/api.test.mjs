import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { AMBER, CLIENT_ID, KID, LUKE, call, familyGroup, memberToken, table } from './helpers/links-api.mjs';

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
  assert.deepEqual(body.sections, [{ id: 'tech', name: 'Technology', order: 1, owner: LUKE, level: 'owner', share: [], rev: 1 }]);
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

const amber = memberToken(AMBER), kid = memberToken(KID);
const seen = async (token) => (await call('GET', '/all', undefined, token)).body;

test('a section is its maker’s alone until shared, links and all', async () => {
  await call('PUT', '/links/a', { sectionId: 'tech', url: 'https://a.com' });
  assert.deepEqual(await seen(amber), { sections: [], links: [] });
  // Amber can’t reach it by id either: as if it weren’t there
  assert.equal((await call('PUT', '/sections/tech', { name: 'Mine now', rev: 1 }, amber)).status, 404);
  assert.equal((await call('DELETE', '/sections/tech', undefined, amber)).status, 404);
  assert.equal((await call('PUT', '/links/b', { sectionId: 'tech', url: 'https://b.com' }, amber)).status, 400);
  assert.equal((await call('PUT', '/links/a', { sectionId: 'tech', url: 'https://evil.com' }, amber)).status, 400);
  assert.equal((await call('DELETE', '/links/a', undefined, amber)).status, 404);
  // Her own section is hers, and Luke doesn’t see it
  await call('PUT', '/sections/hers', { name: 'Recipes' }, amber);
  assert.deepEqual((await seen(amber)).sections.map((x) => [x.id, x.level]), [['hers', 'owner']]);
  assert.deepEqual((await seen()).sections.map((x) => x.id), ['tech']);
  // Moving her link into his section, or his into hers, needs edit on both
  await call('PUT', '/links/h', { sectionId: 'hers', url: 'https://h.com' }, amber);
  assert.equal((await call('PUT', '/links/a', { sectionId: 'hers', url: 'https://a.com' }, amber)).status, 404, 'his link, from a section she can’t see');
  assert.equal((await call('GET', '/all')).body.links.find((l) => l.id === 'a').sectionId, 'tech');
});

test('shared to see: read only', async () => {
  await call('PUT', '/links/a', { sectionId: 'tech', url: 'https://a.com' });
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1, share: [{ who: `sub:${AMBER}`, level: 'read' }], rev: 1 });
  const v = await seen(amber);
  assert.deepEqual([v.sections[0].level, v.links.map((l) => l.id)], ['read', ['a']]);
  assert.equal((await call('PUT', '/links/b', { sectionId: 'tech', url: 'https://b.com' }, amber)).status, 403);
  assert.equal((await call('PUT', '/links/a', { sectionId: 'tech', url: 'https://x.com' }, amber)).status, 403);
  assert.equal((await call('DELETE', '/links/a', undefined, amber)).status, 403);
  assert.equal((await call('PUT', '/sections/tech', { name: 'X', rev: 2 }, amber)).status, 403);
  assert.deepEqual(await seen(kid), { sections: [], links: [] }, 'and only her');
});

test('shared to edit: links and the name, but only the owner shares or deletes', async () => {
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  assert.equal((await call('PUT', '/links/b', { sectionId: 'tech', url: 'https://b.com' }, amber)).status, 200);
  assert.equal((await call('DELETE', '/links/b', undefined, amber)).status, 200);
  const r = await call('PUT', '/sections/tech', { name: 'Tech', order: 1, rev: 2 }, amber);
  assert.deepEqual([r.status, r.body.name, r.body.level, r.body.share.length], [200, 'Tech', 'edit', 1], 'renaming keeps the sharing');
  assert.equal((await call('PUT', '/sections/tech', { name: 'Tech', share: [{ who: `sub:${AMBER}`, level: 'edit' }, { who: `sub:${KID}`, level: 'read' }], rev: 3 }, amber)).status, 403);
  assert.equal((await call('PUT', '/sections/tech', { name: 'Tech', share: [], rev: 3 }, amber)).status, 403);
  assert.equal((await call('DELETE', '/sections/tech', undefined, amber)).status, 403);
  assert.equal((await seen()).sections[0].name, 'Tech');
});

test('shared with a family group: everyone in it, and no one once they leave it', async () => {
  familyGroup('gkids12345', 'Kids', [KID]);
  await call('PUT', '/sections/tech', { name: 'Technology', share: [{ who: 'group:gkids12345', level: 'read' }], rev: 1 });
  assert.deepEqual((await seen(kid)).sections.map((x) => x.level), ['read']);
  assert.deepEqual(await seen(amber), { sections: [], links: [] });
  familyGroup('gkids12345', 'Kids', []);
  assert.deepEqual(await seen(kid), { sections: [], links: [] });
});

test('sections are rev-checked: a stale save gets 409 with the current one', async () => {
  assert.equal((await call('PUT', '/sections/tech', { name: 'A', rev: 1 })).body.rev, 2);
  const stale = await call('PUT', '/sections/tech', { name: 'B', rev: 1 });
  assert.deepEqual([stale.status, stale.body.current.name], [409, 'A']);
  assert.equal((await call('PUT', '/sections/tech', { name: 'C' })).status, 409, 'no rev on an existing one is a conflict, not an overwrite');
  for (const share of ['all', [{ who: 'everyone', level: 'edit' }], [{ who: `sub:${AMBER}`, level: 'owner' }]]) {
    assert.equal((await call('PUT', '/sections/tech', { name: 'A', share, rev: 2 })).status, 400, JSON.stringify(share));
  }
});

test('share options: the others in Links, and the family’s groups', async () => {
  familyGroup('gkids12345', 'Kids', [KID]);
  const r = (await call('GET', '/share-options')).body;
  assert.deepEqual(r.people.map((x) => x.name), ['amber@x.test', 'Kid']);
  assert.deepEqual(r.groups, [{ id: 'gkids12345', name: 'Kids' }]);
});
