import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AMBER, LUKE, call, memberToken, table } from './helpers/links-api.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

async function open(sub = LUKE) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://links.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => memberToken(sub), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, memberToken(sub));
        return json(r.status, r.body);
      };
    },
  });
  await wait(80);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const type = (sel, v) => { el(sel).value = v; };
  const submit = async (sel = 'form.edit') => { el(sel).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await wait(); };
  return { d, el, type, submit, click: async (sel) => { el(sel).click(); await wait(); }, close: () => dom.window.close() };
}

beforeEach(async () => {
  table.clear();
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1 });
  await call('PUT', '/links/unifi', { sectionId: 'tech', url: 'https://unifi.ui.com/', title: 'UniFi', order: 1 });
});

test('shows sections with their links, opening in a new tab', async () => {
  const p = await open();
  assert.equal(p.el('.sec-head h2').textContent, 'Technology');
  const a = p.el('.link a');
  assert.equal(a.textContent, 'UniFi');
  assert.equal(a.getAttribute('href'), 'https://unifi.ui.com/');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
  assert.equal(p.el('.link small').textContent, 'unifi.ui.com');
  p.close();
});

test('add a link: a bare domain becomes https, and the title defaults to the host', async () => {
  const p = await open();
  await p.click('[data-addlink="tech"]');
  p.type('form.edit [name="url"]', 'home-assistant.local:8123');
  await p.submit();
  const { body } = await call('GET', '/all');
  const added = body.links.find((l) => l.id !== 'unifi');
  assert.equal(added.url, 'https://home-assistant.local:8123/');
  assert.equal(added.title, 'home-assistant.local');
  assert.equal(p.d.querySelectorAll('.link').length, 2);
  p.close();
});

test('the page refuses non-web links before sending them', async () => {
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
    const p = await open();
    await p.click('[data-addlink="tech"]');
    p.type('form.edit [name="url"]', bad);
    await p.submit();
    assert.match(p.el('#status').textContent, /web address/, bad);
    p.close();
  }
  assert.equal((await call('GET', '/all')).body.links.length, 1);
});

test('edit a link’s title and address', async () => {
  const p = await open();
  await p.click('[data-edit="unifi"]');
  assert.equal(p.el('form.edit [name="title"]').value, 'UniFi');
  p.type('form.edit [name="title"]', 'UniFi console');
  await p.submit();
  assert.equal((await call('GET', '/all')).body.links[0].title, 'UniFi console');
  assert.equal(p.el('.link a').textContent, 'UniFi console');
  p.close();
});

test('add a section, then it opens straight to adding its first link', async () => {
  const p = await open();
  await p.click('#add-section');
  p.type('form.edit [name="name"]', 'House');
  await p.submit();
  assert.deepEqual((await call('GET', '/all')).body.sections.map((s) => s.name), ['Technology', 'House']);
  assert.ok(p.d.querySelector('form.edit [name="url"]'), 'link form is open in the new section');
  p.close();
});

test('rename a section', async () => {
  const p = await open();
  await p.click('[data-rename="tech"]');
  p.type('form.edit [name="name"]', 'Tech & network');
  await p.submit();
  assert.equal((await call('GET', '/all')).body.sections[0].name, 'Tech & network');
  p.close();
});

test('deletes take two clicks; a section warns how many links go with it', async () => {
  const p = await open();
  await p.click('[data-del="unifi"]');
  assert.equal(p.el('[data-del="unifi"]').textContent, 'Confirm');
  assert.equal((await call('GET', '/all')).body.links.length, 1);
  await p.click('[data-del="unifi"]');
  assert.equal((await call('GET', '/all')).body.links.length, 0);

  await call('PUT', '/links/x', { sectionId: 'tech', url: 'https://a.com' });
  const q = await open();
  await q.click('[data-secdel="tech"]');
  assert.equal(q.el('[data-secdel="tech"]').textContent, 'Delete with 1 link?');
  await q.click('[data-secdel="tech"]');
  assert.deepEqual((await call('GET', '/all')).body, { sections: [], links: [] });
  p.close(); q.close();
});

test('titles are shown as text, never as HTML', async () => {
  await call('PUT', '/links/evil', { sectionId: 'tech', url: 'https://a.com', title: '<img src=x onerror=alert(1)>', order: 2 });
  const p = await open();
  assert.equal(p.d.querySelectorAll('.link img').length, 0);
  assert.match(p.d.querySelectorAll('.link a')[1].textContent, /<img/);
  p.close();
});

test('share a section from the page, and take it back', async () => {
  const p = await open();
  assert.equal(p.d.querySelector('.shared'), null, 'just yours: nothing to say');
  await p.click('[data-share="tech"]');
  assert.match(p.el('form[data-form="share"]').textContent, /Just you/);
  p.el('form[data-form="share"] [name="who"]').value = `sub:${AMBER}`;
  p.el('form[data-form="share"] [name="level"]').value = 'read';
  await p.submit('form[data-form="share"]');
  assert.deepEqual((await call('GET', '/all')).body.sections[0].share, [{ who: `sub:${AMBER}`, level: 'read' }]);
  assert.match(p.el('.shared').textContent, /Shared with amber@x\.test/);
  assert.match(p.el('.shares').textContent, /amber@x\.test · can see/);
  await p.click('[data-unshare="0"]');
  assert.deepEqual((await call('GET', '/all')).body.sections[0].share, []);
  p.close();
});

test('shared with you to see: whose it is, and no buttons to change it', async () => {
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1, share: [{ who: `sub:${AMBER}`, level: 'read' }], rev: 1 });
  const p = await open(AMBER);
  assert.equal(p.el('.link a').textContent, 'UniFi');
  assert.equal(p.el('.shared').textContent, 'Luke’s, shared with you to see');
  for (const sel of ['[data-share]', '[data-rename]', '[data-secdel]', '[data-edit]', '[data-del]', '[data-addlink]']) {
    assert.equal(p.d.querySelector(sel), null, sel);
  }
  p.close();
});

test('shared with you to edit: add and rename, but not share or delete the section', async () => {
  await call('PUT', '/sections/tech', { name: 'Technology', order: 1, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  const p = await open(AMBER);
  assert.equal(p.el('.shared').textContent, 'Luke’s, shared with you');
  assert.ok(p.d.querySelector('[data-addlink="tech"]') && p.d.querySelector('[data-rename="tech"]') && p.d.querySelector('[data-edit="unifi"]'));
  assert.equal(p.d.querySelector('[data-share]'), null);
  assert.equal(p.d.querySelector('[data-secdel]'), null);
  await p.click('[data-rename="tech"]');
  p.type('form.edit [name="name"]', 'Tech');
  await p.submit();
  assert.equal((await call('GET', '/all')).body.sections[0].name, 'Tech');
  assert.equal((await call('GET', '/all')).body.sections[0].share.length, 1, 'still shared with her');
  p.close();
});

test('a new section is yours alone, and says so', async () => {
  const p = await open(AMBER);
  assert.equal(p.d.querySelectorAll('.section').length, 0);
  await p.click('#add-section');
  p.type('form.edit [name="name"]', 'Recipes');
  await p.submit();
  assert.match(p.el('#status').textContent, /yours until you share it/);
  assert.deepEqual((await call('GET', '/all')).body.sections.map((x) => x.name), ['Technology'], 'Luke doesn’t see it');
  p.close();
});
