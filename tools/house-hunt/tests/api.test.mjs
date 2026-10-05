import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { forgedToken, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, call, table } from './helpers/house-hunt-api.mjs';

beforeEach(() => table.clear());
const hood = (o = {}) => ({ name: 'Pelham Falls', pool: 'Two pools', high: 'Riverside High', price: 510000, sales: 15, rev: 0, ...o });

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/all', undefined, null)).status, 401);
  assert.equal((await call('GET', '/all', undefined, forgedToken({ clientId: CLIENT_ID, group: 'family_house_hunt' }))).status, 401);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: CLIENT_ID, group: 'someone_else' }))).status, 403);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: 'other-tool', group: 'family_house_hunt' }))).status, 401);
});

test('add, list, update and remove a neighborhood', async () => {
  const added = await call('PUT', '/hoods/pf', hood({ byName: 'Luke' }));
  assert.equal(added.status, 200);
  assert.equal(added.body.rev, 1);
  assert.equal(added.body.status, 'explore');
  assert.equal(added.body.updatedByName, 'Luke');

  const changed = await call('PUT', '/hoods/pf', hood({ rev: 1, status: 'shortlist', rank: 1, notes: 'Loved the trails' }));
  assert.equal(changed.status, 200);
  const { body } = await call('GET', '/all');
  assert.equal(body.hoods.length, 1);
  assert.deepEqual([body.hoods[0].status, body.hoods[0].notes, body.hoods[0].rev, body.hoods[0].price], ['shortlist', 'Loved the trails', 2, 510000]);
  assert.equal(body.hoods[0].updatedBy, undefined, 'user ids stay server-side');

  assert.equal((await call('DELETE', '/hoods/pf')).status, 200);
  assert.deepEqual((await call('GET', '/all')).body.hoods, []);
});

test('a stale edit is refused with the current row, so notes are never silently overwritten', async () => {
  await call('PUT', '/hoods/pf', hood());
  await call('PUT', '/hoods/pf', hood({ rev: 1, notes: 'Amber: HOA is $650/yr', byName: 'Amber' }));
  const stale = await call('PUT', '/hoods/pf', hood({ rev: 1, notes: 'Luke: drove by' }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.notes, 'Amber: HOA is $650/yr');
  assert.equal(stale.body.current.updatedByName, 'Amber');
  assert.equal((await call('PUT', '/hoods/pf', hood())).status, 409, 'rev 0 cannot replace an existing row');
});

test('shared notes start empty and use the same stale-edit check', async () => {
  assert.deepEqual((await call('GET', '/all')).body.notes, { text: '', rev: 0, updatedAt: null, updatedByName: '' });
  const first = await call('PUT', '/notes', { text: 'Must have a fenced yard', rev: 0, byName: 'Luke' });
  assert.equal(first.status, 200);
  assert.equal(first.body.rev, 1);
  assert.equal((await call('PUT', '/notes', { text: 'other', rev: 0 })).status, 409);
  assert.equal((await call('PUT', '/notes', { text: 'Fenced yard; 4 bed', rev: 1 })).status, 200);
  assert.equal((await call('GET', '/all')).body.notes.text, 'Fenced yard; 4 bed');
});

test('validates input', async () => {
  assert.equal((await call('PUT', '/hoods/pf', hood({ name: ' ' }))).status, 400);
  assert.equal((await call('PUT', '/hoods/pf', hood({ rev: undefined }))).status, 400);
  assert.equal((await call('PUT', '/hoods/pf', hood({ price: 4.5 }))).status, 400);
  assert.equal((await call('PUT', '/hoods/pf', hood({ price: '400000' }))).status, 400);
  assert.equal((await call('PUT', '/hoods/pf', hood({ sales: -1 }))).status, 400);
  assert.equal((await call('PUT', '/hoods/pf', hood({ status: 'favorite' }))).status, 400);
  assert.equal((await call('PUT', '/hoods/bad%20id', hood())).status, 400);
  assert.equal((await call('PUT', '/notes', { text: 'x' })).status, 400);
});

test('only web links are kept as sources; an unpriced neighborhood is allowed', async () => {
  const r = await call('PUT', '/hoods/x1', hood({ price: null, sales: null, source: 'javascript:alert(1)' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.source, '');
  assert.equal(r.body.price, null);
  const ok = await call('PUT', '/hoods/x2', hood({ source: 'https://www.palmettopark.com/greer/pelham-falls' }));
  assert.equal(ok.body.source, 'https://www.palmettopark.com/greer/pelham-falls');
});

test('map fields: rank only on the shortlist, details, drive times and a pin', async () => {
  const r = await call('PUT', '/hoods/pf', hood({
    status: 'shortlist', rank: 1, visited: 'Sep 26', fitNote: '', summary: 'River path',
    facts: ['1.2-mile path', ' ', 'Clubhouse'], drives: [{ to: "Mom's house", min: 9, mi: 3.7 }, { to: 'Gym', min: 16 }], ll: [34.8495, -82.2227],
  }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.rank, r.body.visited, r.body.summary], [1, 'Sep 26', 'River path']);
  assert.deepEqual(r.body.facts, ['1.2-mile path', 'Clubhouse']);
  assert.deepEqual(r.body.drives, [{ to: "Mom's house", min: 9, mi: 3.7 }, { to: 'Gym', min: 16, mi: null }]);
  assert.deepEqual(r.body.ll, [34.8495, -82.2227]);
  const moved = await call('PUT', '/hoods/pf', { ...r.body, status: 'nogo', rank: 1 });
  assert.equal(moved.body.rank, null, 'leaving the shortlist drops the rank');
});

test('refuses malformed map fields', async () => {
  assert.equal((await call('PUT', '/hoods/a', hood({ rank: 1.5 }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ ll: [134, -82] }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ ll: '34,-82' }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ facts: 'one' }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ facts: Array(13).fill('x') }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ drives: [{ to: 'Gym', min: 'ten' }] }))).status, 400);
  assert.equal((await call('PUT', '/hoods/a', hood({ drives: [{ to: '', min: 5 }] }))).status, 400);
});

test('places come back with the neighborhoods and have no write routes', async () => {
  table.put({ pk: 'TOOL', sk: 'PLACE#gsp', kind: 'airport', name: 'GSP', note: 'Airport', ll: [34.8954, -82.2172] });
  table.put({ pk: 'TOOL', sk: 'PLACE#mom', kind: 'family', name: "Mom's house", note: '', ll: null });
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.places.map((p) => [p.id, p.kind, p.ll]), [['gsp', 'airport', [34.8954, -82.2172]], ['mom', 'family', null]]);
  assert.equal((await call('PUT', '/places/gsp', {})).status, 404);
});

const listing = (o = {}) => ({ address: '12 Sugar Lake Ct', hoodId: 'pf', price: 615000, beds: 4, baths: 2.5, rank: 1, rev: 0, ...o });

test('listings: add, rank, move, review and delete', async () => {
  const added = await call('PUT', '/listings/l1', listing({ url: 'https://www.zillow.com/x', byName: 'Amber' }));
  assert.equal(added.status, 200);
  assert.deepEqual([added.body.rev, added.body.status, added.body.source, added.body.reviewed, added.body.updatedByName], [1, 'active', 'manual', false, 'Amber']);
  assert.ok(added.body.firstSeenAt);
  const moved = await call('PUT', '/listings/l1', { ...added.body, hoodId: null, rank: 3, reviewed: true, notes: 'Nice yard' });
  assert.deepEqual([moved.body.hoodId, moved.body.rank, moved.body.reviewed, moved.body.notes], [null, 3, true, 'Nice yard']);
  assert.equal(moved.body.firstSeenAt, added.body.firstSeenAt);
  assert.equal((await call('PUT', '/listings/l1', { ...added.body })).status, 409, 'stale rev');
  assert.deepEqual((await call('GET', '/all')).body.listings.map((l) => l.id), ['l1']);
  assert.equal((await call('DELETE', '/listings/l1')).status, 200);
  assert.deepEqual((await call('GET', '/all')).body.listings, []);
});

test('listings: validates input and keeps only web links', async () => {
  assert.equal((await call('PUT', '/listings/l1', listing({ address: '' }))).status, 400);
  assert.equal((await call('PUT', '/listings/l1', listing({ price: '615k' }))).status, 400);
  assert.equal((await call('PUT', '/listings/l1', listing({ baths: -1 }))).status, 400);
  assert.equal((await call('PUT', '/listings/l1', listing({ status: 'maybe' }))).status, 400);
  assert.equal((await call('PUT', '/listings/l1', listing({ hoodId: '../x' }))).status, 400);
  assert.equal((await call('PUT', '/listings/l1', listing({ rev: undefined }))).status, 400);
  const r = await call('PUT', '/listings/l1', listing({ url: 'javascript:alert(1)' }));
  assert.equal(r.body.url, '');
});

test('deleting a neighborhood moves its listings to unsorted', async () => {
  await call('PUT', '/hoods/pf', hood());
  await call('PUT', '/listings/l1', listing());
  await call('PUT', '/listings/l2', listing({ address: '9 Other Rd', hoodId: 'zz' }));
  await call('DELETE', '/hoods/pf');
  const { listings } = (await call('GET', '/all')).body;
  assert.deepEqual(listings.map((l) => [l.id, l.hoodId, l.rank]), [['l1', null, null], ['l2', 'zz', 1]]);
});

test('the inbox shows the latest emails first', async () => {
  table.put({ pk: 'TOOL', sk: 'MAIL#2026-10-01T00:00:00Z#a', receivedAt: '2026-10-01T00:00:00Z', subject: 'Old', from: 'z', outcome: 'ok', found: 1, added: 1, updated: 0 });
  table.put({ pk: 'TOOL', sk: 'MAIL#2026-10-05T00:00:00Z#b', receivedAt: '2026-10-05T00:00:00Z', subject: 'New', from: 'z', outcome: 'ok', found: 2, added: 1, updated: 1 });
  assert.deepEqual((await call('GET', '/all')).body.mail.map((m) => m.subject), ['New', 'Old']);
});
