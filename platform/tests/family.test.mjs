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
let clock = new Date('2026-10-19T14:00:00Z');
const codes = [];
const handler = createApi({
  table: 'family-people', issuer: ISSUER, clientId: 'home-client', users: async () => users, now: () => clock,
  sendCode: async (m) => codes.push(m), code: () => '424242',
});
const ROUTES = ['GET /people', 'PUT /people/{sub}', 'PUT /groups/{id}', 'DELETE /groups/{id}', 'GET /home', 'PUT /home',
  'GET /me/emails', 'POST /me/emails', 'POST /me/emails/verify', 'DELETE /me/emails/{address}'];
const call = caller(handler, ROUTES);
// dot-y.co's tokens carry all of a person's groups
const admin = () => accessToken({ clientId: 'home-client', sub: LUKE, 'cognito:groups': ['family_admin', 'family_house'] });
const member = () => accessToken({ clientId: 'home-client', sub: AMBER, 'cognito:groups': ['family_house', 'family_house:admin'] });
beforeEach(() => { table.clear(); codes.length = 0; clock = new Date('2026-10-19T14:00:00Z'); });

test('only family admins, with dot-y.co’s token', async () => {
  for (const [m, p, b] of [['GET', '/people'], ['PUT', `/people/${KID}`, { name: 'x' }], ['PUT', '/groups/gkids00001', { name: 'Kids', members: [] }], ['DELETE', '/groups/gkids00001']]) {
    assert.equal((await call(m, p, b, member())).status, 403, `${m} ${p}: a tool’s admin isn’t a family admin`);
    assert.equal((await call(m, p, b, accessToken({ clientId: 'house-client', sub: LUKE, 'cognito:groups': ['family_admin'] }))).status, 401, 'another app’s token');
  }
  assert.deepEqual(table.keys(), []);
});

test('home: anyone signed in at dot-y.co arranges their own, with rev checks', async () => {
  const amber = () => accessToken({ clientId: 'home-client', sub: AMBER, 'cognito:groups': ['family_lists'] });
  const luke = () => accessToken({ clientId: 'home-client', sub: LUKE, 'cognito:groups': [] });
  assert.deepEqual((await call('GET', '/home', undefined, amber())).body, { sections: null, rev: 0 }, 'nothing saved yet');
  const sections = [{ id: 'sdaily01', name: ' Daily ', tiles: ['family_lists', 'family_assistant'] }, { id: 'sother01', name: '', tiles: [] }];
  const saved = (await call('PUT', '/home', { sections, rev: 0 }, amber())).body;
  assert.deepEqual(saved, { sections: [{ id: 'sdaily01', name: 'Daily', tiles: ['family_lists', 'family_assistant'] }, { id: 'sother01', name: '', tiles: [] }], rev: 1 });
  assert.equal((await call('PUT', '/home', { sections, rev: 0 }, amber())).status, 409, 'a first save can’t overwrite one');
  const stale = await call('PUT', '/home', { sections: [], rev: 0 }, amber());
  assert.deepEqual(stale.body.current, saved, 'a 409 carries what’s saved');
  assert.equal((await call('PUT', '/home', { sections: [], rev: 1 }, amber())).body.rev, 2);
  assert.deepEqual((await call('GET', '/home', undefined, luke())).body, { sections: null, rev: 0 }, 'each person sees only their own');
  assert.deepEqual(table.get('HOME', AMBER).sections, []);
  assert.equal((await call('GET', '/home', undefined, accessToken({ clientId: 'lists-client', sub: AMBER }))).status, 401, 'another app’s token');
  assert.equal((await call('GET', '/people', undefined, amber())).status, 403, 'the rest stays for family admins');
});

test('bad home layouts are refused', async () => {
  const t = () => accessToken({ clientId: 'home-client', sub: AMBER });
  for (const [sections, why] of [
    ['x', 'not a list'],
    [[{ id: 'bad', name: '', tiles: [] }], 'section ids start with s'],
    [[{ id: 'sone0001', name: '', tiles: [] }, { id: 'sone0001', name: '', tiles: [] }], 'duplicate section'],
    [[{ id: 'sone0001', name: 'x'.repeat(41), tiles: [] }], 'long name'],
    [[{ id: 'sone0001', name: '', tiles: ['<b>'] }], 'odd tile'],
    [[{ id: 'sone0001', name: '', tiles: ['family_lists'] }, { id: 'stwo0001', name: '', tiles: ['family_lists'] }], 'a tile in two places'],
  ]) assert.equal((await call('PUT', '/home', { sections, rev: 0 }, t())).status, 400, why);
  assert.equal((await call('PUT', '/home', { sections: [], rev: -1 }, t())).status, 400);
  assert.equal((await call('PUT', '/home', { sections: [] }, t())).status, 400, 'rev is required');
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

// ---- the home page: sections the person arranges, saved through GET/PUT /home ----

const HOME = readFileSync(new URL('../core/portal/index.html', import.meta.url), 'utf8').replace('<script src="/family-auth.js"></script>', '');
const APPS = [
  { group: 'family_lists', title: 'Lists', description: 'To-dos', url: 'https://lists.dot-y.co/', icon: 'checklist' },
  { group: 'family_assistant', title: 'Dot', description: 'Chat', url: 'https://assistant.dot-y.co/', icon: 'chat' },
  { group: 'family_house', title: 'House', description: 'Rooms', url: 'https://house.dot-y.co/', icon: 'house' },
  { group: 'lukes_boards', title: 'Boards', description: 'Not hers', url: 'https://boards.dot-y.co/', icon: 'leaf' },
];
const amberHome = () => accessToken({ clientId: 'home-client', sub: AMBER, 'cognito:groups': ['family_lists', 'family_assistant', 'family_house'] });

async function home({ api = true } = {}) {
  const token = amberHome();
  const dom = new JSDOM(HOME, {
    runScripts: 'dangerously', url: 'https://dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollBy = () => {}; // dragging near the window's edge scrolls it
      w.FamilyAuth = { init: async () => ({ email: 'amber@x.test', given_name: 'Amber', 'cognito:groups': ['family_lists', 'family_assistant', 'family_house'] }), accessToken: async () => token, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === '/config.json') return json(200, {});
        if (url === '/apps.json') return json(200, APPS);
        if (url === '/family-config.json') return json(200, { apiUrl: 'https://family.test' });
        if (!api) throw new TypeError('Failed to fetch');
        const r = await call(o.method || 'GET', url.slice('https://family.test'.length), o.body ? JSON.parse(o.body) : undefined, token);
        return json(r.status, r.body);
      };
    },
  });
  opened.push(dom.window);
  await wait(150);
  const w = dom.window, d = w.document;
  const layout = () => [...d.querySelectorAll('[data-section]')].map((s) => [s.querySelector('h2, [data-name]')?.[s.querySelector('h2') ? 'textContent' : 'value'] ?? '', [...s.querySelectorAll('[data-tile]')].map((t) => t.dataset.tile)]);
  // jsdom has no layout: point "the pointer is over" at an element, and every rect is 0×0 (so drops land after it)
  const at = (el) => { d.elementFromPoint = () => el; };
  const ptr = (type, el, x = 5) => (el || d).dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 5, button: 0 }));
  const drag = async (from, over) => { at(from); ptr('pointerdown', from); at(over); ptr('pointermove', d); ptr('pointerup', d); await wait(); };
  return { w, d, layout, drag, el: (sel) => d.querySelector(sel), click: async (sel) => { d.querySelector(sel).click(); await wait(); } };
}

test('home: with nothing saved, one section of every tool the person may use', async () => {
  const p = await home();
  assert.deepEqual(p.layout(), [['Your tools', ['family_lists', 'family_assistant', 'family_house']]]);
  assert.equal(p.el('#arrange').hidden, false);
  assert.equal(table.get('HOME', AMBER), undefined, 'looking saves nothing');
});

test('home: a saved arrangement, with tools gained since added to the first section and lost ones left out', async () => {
  await call('PUT', '/home', { rev: 0, sections: [
    { id: 'sdaily01', name: 'Daily', tiles: ['family_assistant', 'lukes_boards'] },
    { id: 'sempty01', name: 'Later', tiles: [] },
    { id: 'shome001', name: 'Home', tiles: ['family_lists'] },
  ] }, amberHome());
  const p = await home();
  assert.deepEqual(p.layout(), [['Daily', ['family_assistant', 'family_house']], ['Home', ['family_lists']]], 'an empty section shows only while arranging');
  assert.equal(p.el('[data-tile="family_lists"]').getAttribute('href'), 'https://lists.dot-y.co/');
});

test('home: arrange: add and name a section, drag a tile into it, reorder sections, remove one', async () => {
  const p = await home();
  await p.click('#arrange');
  assert.equal(p.el('#arrange').textContent, 'Done');
  await p.click('#add-section');
  const name = p.d.querySelectorAll('[data-name]')[1];
  name.value = 'Around the house';
  name.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait();
  await p.drag(p.el('[data-tile="family_house"]'), p.d.querySelectorAll('.tiles')[1]);
  assert.deepEqual(p.layout(), [['Your tools', ['family_lists', 'family_assistant']], ['Around the house', ['family_house']]]);
  assert.deepEqual(table.get('HOME', AMBER).sections.map((s) => [s.name, s.tiles]), p.layout(), 'saved as shown');

  await p.drag(p.el('[data-tile="family_lists"]'), p.el('[data-tile="family_assistant"]'));
  assert.deepEqual(p.layout()[0][1], ['family_assistant', 'family_lists'], 'dropped after the tile it’s over');
  const clicked = new p.w.MouseEvent('click', { bubbles: true, cancelable: true });
  p.el('[data-tile="family_lists"]').dispatchEvent(clicked);
  assert.equal(clicked.defaultPrevented, true, 'while arranging, a tile isn’t a link');

  await p.drag(p.d.querySelectorAll('[data-handle]')[0], p.d.querySelectorAll('[data-section]')[1]);
  assert.deepEqual(p.layout().map((s) => s[0]), ['Around the house', 'Your tools'], 'sections move by their handle');

  p.d.querySelectorAll('[data-remove]')[1].click();
  await wait();
  assert.deepEqual(p.layout(), [['Around the house', ['family_house', 'family_assistant', 'family_lists']]], 'a removed section’s tools move up');
  assert.equal(p.el('[data-remove]'), null, 'the last section stays');
  await p.click('#arrange');
  assert.equal(p.el('[data-section] h2').textContent, 'Around the house');
  assert.deepEqual(table.get('HOME', AMBER).sections.map((s) => [s.name, s.tiles]), p.layout());
  assert.equal(table.get('HOME', AMBER).rev, 6, 'one save per change');
});

test('home: saved from another device first: the page shows that version and says so', async () => {
  const p = await home();
  await call('PUT', '/home', { rev: 0, sections: [{ id: 'sphone01', name: 'From my phone', tiles: ['family_house'] }] }, amberHome());
  await p.click('#arrange');
  await p.drag(p.el('[data-tile="family_house"]'), p.el('[data-tile="family_lists"]'));
  assert.deepEqual(p.layout(), [['From my phone', ['family_house', 'family_lists', 'family_assistant']]]);
  assert.match(p.el('#status').textContent, /another device/);
  assert.equal(table.get('HOME', AMBER).sections[0].name, 'From my phone', 'not overwritten');
});

test('home: without the family API the tiles still show, with nothing to arrange', async () => {
  const p = await home({ api: false });
  assert.deepEqual(p.layout(), [['Your tools', ['family_lists', 'family_assistant', 'family_house']]]);
  assert.equal(p.el('#arrange').hidden, true);
});

// --- each person's other email addresses (dot-y.co/me) ---
const as = (sub) => accessToken({ clientId: 'home-client', sub, 'cognito:groups': [] });
const WORK = 'luke@work.example';

test('emails: add one, the code goes to it, and it counts once the code comes back', async () => {
  const add = await call('POST', '/me/emails', { address: ' Luke@Work.Example ' }, as(LUKE));
  assert.equal(add.status, 200);
  assert.equal(add.body.state, 'pending');
  assert.deepEqual(codes, [{ to: WORK, code: '424242', name: 'Luke Doty' }]);
  assert.equal(table.get('EMAIL', WORK), undefined, 'not his until the code comes back');
  assert.equal((await call('POST', '/me/emails/verify', { address: WORK, code: '000000' }, as(LUKE))).status, 400);
  assert.equal((await call('POST', '/me/emails/verify', { address: WORK, code: '424 242' }, as(LUKE))).body.state, 'verified');
  assert.equal(table.get('EMAIL', WORK).sub, LUKE);
  assert.deepEqual((await call('GET', '/me/emails', undefined, as(LUKE))).body, { primary: 'l@x.test', emails: [{ address: WORK, state: 'verified' }] });
  // Nobody stores the code itself
  assert.ok(!JSON.stringify(table.dump()).includes('424242'));
});

test('emails: not an account’s email, not someone else’s, one code a minute, five tries, thirty minutes', async () => {
  assert.equal((await call('POST', '/me/emails', { address: 'l@x.test' }, as(LUKE))).status, 409, 'his own account email');
  assert.equal((await call('POST', '/me/emails', { address: 'amber@x.test' }, as(LUKE))).status, 409, 'Amber’s account email');
  assert.equal((await call('POST', '/me/emails', { address: 'not an email' }, as(LUKE))).status, 400);
  await call('POST', '/me/emails', { address: WORK }, as(LUKE));
  await call('POST', '/me/emails/verify', { address: WORK, code: '424242' }, as(LUKE));
  assert.equal((await call('POST', '/me/emails', { address: WORK }, as(AMBER))).status, 409, 'his now');
  // A second address: resends wait a minute; wrong codes run out; codes expire
  await call('POST', '/me/emails', { address: 'luke@home.example' }, as(LUKE));
  assert.equal((await call('POST', '/me/emails', { address: 'luke@home.example' }, as(LUKE))).status, 429);
  for (let i = 0; i < 5; i++) await call('POST', '/me/emails/verify', { address: 'luke@home.example', code: '111111' }, as(LUKE));
  assert.equal((await call('POST', '/me/emails/verify', { address: 'luke@home.example', code: '424242' }, as(LUKE))).status, 429);
  clock = new Date(clock.getTime() + 61_000);
  assert.equal((await call('POST', '/me/emails', { address: 'luke@home.example' }, as(LUKE))).status, 200, 'a new code, new tries');
  clock = new Date(clock.getTime() + 31 * 60_000);
  assert.equal((await call('POST', '/me/emails/verify', { address: 'luke@home.example', code: '424242' }, as(LUKE))).status, 410);
});

test('emails: each person sees and removes only their own; removing frees the address', async () => {
  await call('POST', '/me/emails', { address: WORK }, as(LUKE));
  await call('POST', '/me/emails/verify', { address: WORK, code: '424242' }, as(LUKE));
  assert.deepEqual((await call('GET', '/me/emails', undefined, as(AMBER))).body.emails, []);
  await call('DELETE', `/me/emails/${encodeURIComponent(WORK)}`, undefined, as(AMBER));
  assert.equal(table.get('EMAIL', WORK).sub, LUKE, 'Amber can’t remove his');
  await call('DELETE', `/me/emails/${encodeURIComponent(WORK)}`, undefined, as(LUKE));
  assert.equal(table.get('EMAIL', WORK), undefined);
  assert.equal((await call('POST', '/me/emails', { address: WORK }, as(AMBER))).status, 200);
});

// ---- dot-y.co/me ----

const ME = readFileSync(new URL('../core/portal/me.html', import.meta.url), 'utf8').replace('<script src="/family-auth.js"></script>', '');
async function mePage(token) {
  const dom = new JSDOM(ME, {
    runScripts: 'dangerously', url: 'https://dot-y.co/me', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token, login() {} };
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
  const w = dom.window, d = w.document;
  const submit = async (sel) => { d.querySelector(sel).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await wait(); };
  return { d, w, submit, text: (sel) => [...d.querySelectorAll(sel)].map((e) => e.textContent.trim()) };
}

test('dot-y.co/me: anyone adds an address, enters the code, and it’s confirmed; then removes it', async () => {
  const p = await mePage(as(AMBER));
  assert.deepEqual(p.text('.addr'), ['amber@x.test']);
  p.d.querySelector('[data-add] [name="address"]').value = 'amber@work.example';
  await p.submit('[data-add]');
  assert.deepEqual(codes.map((c) => c.to), ['amber@work.example']);
  assert.match(p.d.querySelector('.rows').textContent, /Waiting for the code/);
  p.d.querySelector('[data-verify] [name="code"]').value = '424242';
  await p.submit('[data-verify]');
  assert.match(p.d.querySelector('.rows').textContent, /Confirmed/);
  assert.equal(table.get('EMAIL', 'amber@work.example').sub, AMBER);
  p.d.querySelector('[data-remove]').click();
  await wait();
  assert.equal(p.d.querySelector('.rows'), null);
  assert.equal(table.get('EMAIL', 'amber@work.example'), undefined);
});
