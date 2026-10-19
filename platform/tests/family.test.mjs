import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from './helpers/tokens.mjs';
import { fakeTable } from './helpers/fake-table.mjs';
import { caller } from './helpers/http.mjs';
import { makePeople } from '../api/people.mjs';

const table = fakeTable({ pageSize: 2 });
const { createApi } = await import('../family/api/api.mjs');
const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004', AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07', KID = '11111111-1111-1111-1111-111111111111';
const users = [{ sub: LUKE, name: 'Luke Doty', email: 'l@x.test' }, { sub: AMBER, name: 'amber@x.test', email: 'amber@x.test' }, { sub: KID, name: 'Kid', email: null }];
const handler = createApi({ table: 'family-people', issuer: ISSUER, clientId: 'home-client', users: async () => users, now: () => new Date('2026-10-19T14:00:00Z') });
const ROUTES = ['GET /people', 'PUT /people/{sub}', 'PUT /groups/{id}', 'DELETE /groups/{id}'];
const call = caller(handler, ROUTES);
// dot-y.co's tokens carry all of a person's groups
const admin = () => accessToken({ clientId: 'home-client', sub: LUKE, 'cognito:groups': ['family_admin', 'family_house'] });
const member = () => accessToken({ clientId: 'home-client', sub: AMBER, 'cognito:groups': ['family_house', 'family_house:admin'] });
beforeEach(() => table.clear());

test('only family admins, with dot-y.co’s token', async () => {
  for (const [m, p, b] of [['GET', '/people'], ['PUT', `/people/${KID}`, { name: 'x' }], ['PUT', '/groups/gkids00001', { name: 'Kids', members: [] }], ['DELETE', '/groups/gkids00001']]) {
    assert.equal((await call(m, p, b, member())).status, 403, `${m} ${p}: a tool’s admin isn’t a family admin`);
    assert.equal((await call(m, p, b, accessToken({ clientId: 'house-client', sub: LUKE, 'cognito:groups': ['family_admin'] }))).status, 401, 'another app’s token');
  }
  assert.deepEqual(table.keys(), []);
});

test('groups: create, change members with rev checks, names unique, delete', async () => {
  const g = (await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [KID, KID] }, admin())).body;
  assert.deepEqual(g, { id: 'gkids00001', name: 'Kids', members: [KID], rev: 1 });
  assert.equal((await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [] }, admin())).status, 409, 'a new group can’t overwrite one');
  assert.equal((await call('PUT', '/groups/gkids00002', { name: 'kids', members: [] }, admin())).status, 409, 'names are unique, ignoring case');
  assert.equal((await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [KID, AMBER], rev: 1 }, admin())).body.rev, 2);
  const stale = await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [], rev: 1 }, admin());
  assert.deepEqual([stale.status, stale.body.current.members], [409, [KID, AMBER]]);
  assert.equal(table.get('GROUP', 'gkids00001').changedBy, 'test-user');
  assert.equal((await call('DELETE', '/groups/gkids00001', undefined, admin())).status, 200);
  assert.equal(table.get('GROUP', 'gkids00001'), undefined);
});

test('bad groups are refused', async () => {
  assert.equal((await call('PUT', '/groups/kids', { name: 'Kids', members: [] }, admin())).status, 400, 'ids start with g');
  assert.equal((await call('PUT', '/groups/gkids00001', { name: '<b>', members: [] }, admin())).status, 400);
  assert.equal((await call('PUT', '/groups/gkids00001', { name: 'Kids', members: ['luke'] }, admin())).status, 400);
  assert.equal((await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [], rev: 'x' }, admin())).status, 400);
  assert.deepEqual(table.keys(), []);
});

test('people: every account, with display names that override Cognito’s', async () => {
  assert.deepEqual((await call('PUT', `/people/${AMBER}`, { name: 'Amber' }, admin())).body, { sub: AMBER, name: 'Amber' });
  const r = (await call('GET', '/people', undefined, admin())).body;
  assert.deepEqual(r.people.map((p) => [p.sub, p.displayName]), [[AMBER, 'Amber'], [KID, null], [LUKE, null]]);
  await call('PUT', `/people/${AMBER}`, { name: '' }, admin());
  assert.equal(table.get('PERSON', AMBER), undefined, 'blank clears it');
  assert.equal((await call('PUT', '/people/not-a-sub', { name: 'x' }, admin())).status, 400);
});

test('tools read groups and names, cached for a minute', async () => {
  let t = 0;
  const people = makePeople({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-people', now: () => t });
  await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [KID] }, admin());
  await call('PUT', `/people/${AMBER}`, { name: 'Amber' }, admin());
  assert.deepEqual(await people.groups(), [{ id: 'gkids00001', name: 'Kids', members: [KID] }]);
  assert.deepEqual([...(await people.names())], [[AMBER, 'Amber']]);
  await call('PUT', '/groups/gkids00001', { name: 'Kids', members: [], rev: 1 }, admin());
  assert.deepEqual((await people.groups())[0].members, [KID], 'still cached');
  t = 61_000;
  assert.deepEqual((await people.groups())[0].members, []);
});

test('the routes in platform/family/main.tf match the handler', () => {
  const tf = readFileSync(new URL('../family/main.tf', import.meta.url), 'utf8');
  const block = /routes\s+= \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  assert.match(tf, /"cognito-idp:ListUsers"/);
  assert.doesNotMatch(tf, /AdminAddUserToGroup|AdminRemoveUserFromGroup|CreateGroup/, 'the family API never changes anyone’s access');
});

// ---- the page ----

const HTML = readFileSync(new URL('../core/portal/family.html', import.meta.url), 'utf8').replace('<script src="/family-auth.js"></script>', '');
const opened = [];
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { while (opened.length) opened.pop().close(); });

async function page(token = admin(), confirm = true) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://dot-y.co/family', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token };
      w.confirm = () => confirm;
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === '/config.json') return json(200, {});
        if (url === '/family-config.json') return json(200, { apiUrl: 'https://family.test' });
        const r = await call(o.method || 'GET', url.slice('https://family.test'.length), o.body ? JSON.parse(o.body) : undefined, token);
        return json(r.status, r.body);
      };
    },
  });
  opened.push(dom.window);
  await wait(150);
  const d = dom.window.document;
  return { d, w: dom.window, text: (sel) => [...d.querySelectorAll(sel)].map((e) => e.textContent.trim()) };
}

test('the page: add a group, tick a member, name someone', async () => {
  const p = await page();
  p.d.getElementById('new-group').value = 'Kids';
  p.d.getElementById('add-group').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  assert.deepEqual(p.text('[data-group] strong'), ['Kids']);
  const box = p.d.querySelector(`[data-group] [data-member="${KID}"]`);
  box.checked = true;
  box.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait();
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('GROUP')).map(([, v]) => v.members), [[KID]]);
  const name = p.d.querySelector(`[data-person="${AMBER}"] [data-name]`);
  name.value = 'Amber';
  name.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait();
  assert.equal(table.get('PERSON', AMBER).name, 'Amber');
  assert.ok(p.text('[data-group] label').includes('Amber'), 'members show by display name');
});

test('the page: someone who isn’t a family admin is told so', async () => {
  const p = await page(member());
  assert.equal(p.text('.status')[0], 'Only family admins can manage groups.');
});
