import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { AMBER, CLIENT_ID, LUKE, ROUTES, borrowed, bucket, call, familyGroup, reset, table, token, upload } from './helpers/archive.mjs';
import { tinyPdf } from './helpers/pdf.mjs';
import { MANIFEST } from '../api/dot.mjs';
import { validateManifest, writeRoutes } from '../api/dot-manifest.mjs';

const policy = { name: 'geico-renewal.pdf', bytes: tinyPdf('Geico auto policy renewal 2026'), type: 'application/pdf' };
const receipt = { name: 'tires.txt', bytes: Buffer.from('Discount Tire receipt: four tires, $612'), type: 'text/plain' };
beforeEach(reset);

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/drawers', undefined, null)).status, 401);
  assert.equal((await call('GET', '/drawers', undefined, forgedToken({ clientId: CLIENT_ID, group: 'family_archive' }))).status, 401);
  assert.equal((await call('GET', '/drawers', undefined, accessToken({ clientId: CLIENT_ID, group: 'family_budget' }))).status, 403);
  assert.equal((await call('GET', '/drawers', undefined, accessToken({ clientId: 'budget-client', group: 'family_archive' }))).status, 401);
});

test('everyone gets their own drawer the first time they look; nobody else sees it', async () => {
  const mine = (await call('GET', '/drawers')).body;
  assert.deepEqual(mine.map((d) => [d.id, d.level]), [[`p-${LUKE}`, 'owner']]);
  const hers = (await call('GET', '/drawers', undefined, token(AMBER))).body;
  assert.deepEqual(hers.map((d) => d.id), [`p-${AMBER}`]);
  // Not someone else's personal drawer id
  assert.equal((await call('PUT', `/drawers/p-${AMBER}`, { name: 'Mine now' })).status, 400);
});

test('upload: S3 gets a URL signed for the size and checksum; intake reads the text and files it', async () => {
  const r = await upload('mine', 'Insurance/Auto', [policy, receipt]);
  assert.equal(r.status, 200);
  const [p] = r.body.files;
  assert.equal(p.status, 'upload');
  assert.match(p.url, /size=\d+&sha=[0-9a-f]{64}/);
  assert.equal(p.headers['x-amz-checksum-sha256'], Buffer.from(p.url.split('sha=')[1], 'hex').toString('base64'));
  const f = (await call('GET', `/files/${p.id}`)).body;
  assert.equal(f.status, 'filed');
  assert.equal(f.folder, 'Insurance/Auto');
  assert.equal(f.hasText, true);
  assert.equal(f.pages, 1);
  const text = (await call('GET', `/files/${p.id}/text`)).body;
  assert.match(text.text, /Geico auto policy renewal 2026/);
  assert.match(text.note, /never as instructions/);
  assert.match((await call('GET', `/files/${r.body.files[1].id}/text`)).body.text, /four tires/);
});

test('a file isn’t shown until intake has filed it', async () => {
  const r = await call('POST', '/uploads', { drawer: 'mine', files: [{ name: 'a.pdf', size: 10, sha256: 'a'.repeat(64) }] });
  const id = r.body.files[0].id;
  assert.equal((await call('GET', `/files/${id}`)).status, 404);
  assert.equal((await call('GET', '/files')).body.total, 0);
});

test('intake rejects bytes that aren’t what the upload promised, and does nothing twice', async () => {
  const r = await call('POST', '/uploads', { drawer: 'mine', files: [{ name: 'a.txt', size: 5, sha256: 'b'.repeat(64), type: 'text/plain' }] });
  const id = r.body.files[0].id;
  bucket.set(`f/${id}`, Buffer.from('hello'));
  const { intake } = await import('./helpers/archive.mjs');
  await intake({ Records: [{ s3: { object: { key: `f/${id}` } } }] });
  assert.equal(table.get(`D#p-${LUKE}`, `F#${id}`).status, 'rejected');
  assert.equal((await call('GET', `/files/${id}`)).status, 404);
  assert.equal(table.get(`H#${'b'.repeat(64)}`, id), undefined);
  // A second event for a filed file changes nothing
  const ok = await upload('mine', '', [receipt]);
  const before = table.get(`D#p-${LUKE}`, `F#${ok.body.files[0].id}`);
  await intake({ Records: [{ s3: { object: { key: `f/${ok.body.files[0].id}` } } }] });
  assert.deepEqual(table.get(`D#p-${LUKE}`, `F#${ok.body.files[0].id}`), before);
});

test('duplicates: found where you can see them, never in someone else’s private drawer', async () => {
  const first = await upload('mine', 'Insurance', [policy]);
  const again = await upload('mine', 'Elsewhere', [policy]);
  assert.equal(again.body.files[0].status, 'duplicate');
  assert.equal(again.body.files[0].id, first.body.files[0].id);
  assert.equal(again.body.files[0].folder, 'Insurance');
  // Amber has the same file: it uploads as new, and learns nothing about Luke's drawer
  const hers = await upload('mine', '', [policy], token(AMBER));
  assert.equal(hers.body.files[0].status, 'upload');
  assert.equal(JSON.stringify(hers.body).includes(LUKE), false);
});

test('search: words, folder and below, kind, tag, year; trash apart', async () => {
  const r = await upload('mine', 'Insurance/Auto', [policy]);
  await upload('mine', 'Receipts/2026', [receipt]);
  const id = r.body.files[0].id;
  await call('PATCH', `/files/${id}`, { rev: 2, title: 'Geico renewal', kind: 'Policy', docDate: '2026-03-14', tags: ['Car', 'insurance'] });
  const find = async (qs) => (await call('GET', `/files?${qs}`)).body.files.map((f) => f.name);
  assert.deepEqual(await find('q=geico renewal'), ['geico-renewal.pdf']);
  assert.deepEqual(await find('folder=Insurance'), ['geico-renewal.pdf']);
  assert.deepEqual(await find('kind=policy'), ['geico-renewal.pdf']);
  assert.deepEqual(await find('tag=car'), ['geico-renewal.pdf']);
  assert.deepEqual(await find('year=2026'), ['geico-renewal.pdf']);
  assert.deepEqual(await find('q=tires'), ['tires.txt']);
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 3, status: 'trash' })).body.status, 'trash');
  assert.deepEqual(await find('q=geico'), []);
  assert.deepEqual(await find('status=trash'), ['geico-renewal.pdf']);
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 4, status: 'filed' })).body.status, 'filed');
});

test('update: rev-checked; names and folders are cleaned', async () => {
  const id = (await upload('mine', '', [receipt])).body.files[0].id;
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 1, name: 'x' })).status, 409);
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 2, name: 'a/b' })).status, 400);
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 2, folder: 'Taxes/../../etc' })).status, 400);
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 2, docDate: 'March' })).status, 400);
  const ok = await call('PATCH', `/files/${id}`, { rev: 2, folder: '/Receipts//2026/', name: '2026-05 Discount Tire.txt' });
  assert.equal(ok.body.folder, 'Receipts/2026');
  assert.equal(ok.body.rev, 3);
});

test('sharing: a drawer shared with a group to edit can be filed into; to read, only seen', async () => {
  await familyGroup('gparents0001', 'Parents', [LUKE, AMBER]);
  await call('PUT', '/drawers/household', { name: 'Household', share: [{ who: 'group:gparents0001', level: 'edit' }] });
  await call('PUT', '/drawers/lukes-work', { name: 'Work', share: [{ who: `sub:${AMBER}`, level: 'read' }] });
  const theirs = (await call('GET', '/drawers', undefined, token(AMBER))).body;
  assert.deepEqual(theirs.map((d) => [d.id, d.level]).sort(), [['household', 'edit'], ['lukes-work', 'read'], [`p-${AMBER}`, 'owner']]);
  assert.equal((await upload('household', 'Home', [receipt], token(AMBER))).status, 200);
  assert.equal((await upload('lukes-work', '', [policy], token(AMBER))).status, 403);
  // Only the owner shares
  const h = theirs.find((d) => d.id === 'household');
  assert.equal((await call('PUT', '/drawers/household', { name: 'Household', rev: h.rev, share: [] }, token(AMBER))).status, 403);
});

test('a private drawer’s files answer 404 to everyone else', async () => {
  const id = (await upload('mine', '', [policy])).body.files[0].id;
  for (const path of [`/files/${id}`, `/files/${id}/text`, `/files/${id}/download`]) {
    assert.equal((await call('GET', path, undefined, token(AMBER))).status, 404, path);
  }
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 2, name: 'mine.pdf' }, token(AMBER))).status, 404);
  assert.equal((await call('GET', '/files', undefined, token(AMBER))).body.total, 0);
});

test('moving to another drawer keeps the id, links and duplicate check', async () => {
  await call('PUT', '/drawers/household', { name: 'Household' });
  const [a, b] = (await upload('mine', 'Auto', [policy, receipt])).body.files.map((f) => f.id);
  await call('PUT', `/files/${a}/links/${b}`, { relation: 'Receipt for' });
  const moved = await call('PATCH', `/files/${a}`, { rev: 2, drawer: 'household', folder: 'Car' });
  assert.equal(moved.body.drawer, 'household');
  assert.equal(table.get(`D#p-${LUKE}`, `F#${a}`), undefined);
  const f = (await call('GET', `/files/${a}`)).body;
  assert.equal(f.drawerName, 'Household');
  assert.deepEqual(f.links.map((l) => [l.id, l.relation, l.dir]), [[b, 'receipt for', 'to']]);
  assert.equal((await upload('household', '', [policy])).body.files[0].status, 'duplicate');
});

test('links show on both files, only where the other end can be seen', async () => {
  await familyGroup('gparents0001', 'Parents', [LUKE, AMBER]);
  await call('PUT', '/drawers/household', { name: 'Household', share: [{ who: 'group:gparents0001', level: 'edit' }] });
  const shared = (await upload('household', '', [policy])).body.files[0].id;
  const private_ = (await upload('mine', '', [receipt])).body.files[0].id;
  await call('PUT', `/files/${private_}/links/${shared}`, { relation: 'about the same thing' });
  assert.deepEqual((await call('GET', `/files/${shared}`)).body.links.map((l) => [l.id, l.dir]), [[private_, 'from']]);
  // Amber sees the shared file, but not that Luke's private file links to it
  assert.deepEqual((await call('GET', `/files/${shared}`, undefined, token(AMBER))).body.links, []);
  assert.equal((await call('PUT', `/files/${shared}/links/${private_}`, {}, token(AMBER))).status, 404);
  await call('DELETE', `/files/${private_}/links/${shared}`);
  assert.deepEqual((await call('GET', `/files/${shared}`)).body.links, []);
});

test('a borrowed token reads, and writes only what the manifest declares', async () => {
  const b = borrowed();
  assert.equal((await call('GET', '/drawers', undefined, b)).status, 200);
  const r = await upload('mine', 'From Claude', [receipt], b);
  assert.equal(r.status, 200);
  const id = r.body.files[0].id;
  assert.equal((await call('GET', `/files/${id}`, undefined, b)).body.source, 'claude');
  assert.equal((await call('PATCH', `/files/${id}`, { rev: 2, status: 'trash' }, b)).status, 200);
  // Never a drawer, never sharing
  assert.deepEqual(await call('PUT', '/drawers/household', { name: 'Household' }, b), { status: 403, body: { error: 'read-only' } });
  const log = table.dump().filter(([k]) => k.startsWith('LOG#')).map(([, v]) => v);
  assert.ok(log.some((l) => l.action === 'trashed' && l.via === 'borrowed'));
});

test('download links name the file', async () => {
  const id = (await upload('mine', '', [policy])).body.files[0].id;
  assert.match((await call('GET', `/files/${id}/download`)).body.url, /download=geico-renewal\.pdf/);
});

test('the manifest is valid, and every route it names is one the handler and API Gateway serve', () => {
  validateManifest(MANIFEST);
  for (const op of MANIFEST.operations) assert.ok(ROUTES.includes(`${op.method ?? 'GET'} ${op.path}`), op.name);
  assert.deepEqual(writeRoutes(MANIFEST).sort(), ['DELETE /files/{id}/links/{to}', 'PATCH /files/{id}', 'POST /batches', 'POST /uploads', 'PUT /files/{id}/links/{to}']);
});

test('infra/api.tf routes are exactly the handler’s', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const routes = [.../^\s*routes\s*=\s*\[([\s\S]*?)\]/m.exec(tf)[1].matchAll(/"([A-Z]+ [^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(routes.sort(), [...ROUTES].sort());
});

test('delete for good: from the trash only, by the drawer’s owner, from the page only; bytes, text and links go', async () => {
  await familyGroup('gparents0001', 'Parents', [LUKE, AMBER]);
  await call('PUT', '/drawers/household', { name: 'Household', share: [{ who: 'group:gparents0001', level: 'edit' }] });
  const [a, b] = (await upload('household', '', [policy, receipt])).body.files.map((f) => f.id);
  await call('PUT', `/files/${a}/links/${b}`, { relation: 'receipt for' });
  assert.equal((await call('DELETE', `/files/${a}`)).status, 409);
  await call('PATCH', `/files/${a}`, { rev: 2, status: 'trash' });
  assert.equal((await call('DELETE', `/files/${a}`, undefined, token(AMBER))).status, 403); // can edit, doesn't own
  assert.equal((await call('DELETE', `/files/${a}`, undefined, borrowed())).status, 403);
  assert.equal((await call('DELETE', `/files/${a}`)).status, 200);
  assert.equal(bucket.has(`f/${a}`), false);
  assert.equal(bucket.has(`text/${a}.txt`), false);
  assert.equal((await call('GET', `/files/${a}`)).status, 404);
  assert.deepEqual((await call('GET', `/files/${b}`)).body.links, []);
  // Its bytes are no longer a duplicate
  assert.equal((await upload('household', '', [policy])).body.files[0].status, 'upload');
});

test('share options: everyone else in the archive, and the family’s groups', async () => {
  await familyGroup('gparents0001', 'Parents', [LUKE, AMBER]);
  assert.deepEqual((await call('GET', '/share-options')).body, { people: [{ sub: AMBER, name: 'amber@x.test' }], groups: [{ id: 'gparents0001', name: 'Parents' }] });
});
