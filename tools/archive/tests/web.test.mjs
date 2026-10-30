import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { AMBER, LUKE, bucket, call, familyGroup, intake, reset, token, upload } from './helpers/archive.mjs';
import { tinyPdf } from './helpers/pdf.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const policy = { name: 'geico-renewal.pdf', bytes: tinyPdf('Geico auto policy renewal'), type: 'application/pdf' };
const receipt = { name: 'tires.txt', bytes: Buffer.from('Discount Tire receipt'), type: 'text/plain' };

async function open(sub = LUKE) {
  const puts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://archive.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'crypto', { value: webcrypto });
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token(sub), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        // The presigned PUT: S3 keeps the bytes, then intake runs as the bucket event would
        if (url.startsWith('https://s3.test/')) {
          const key = new URL(url).pathname.slice(1);
          puts.push({ key, headers: o.headers });
          bucket.set(key, Buffer.from(o.body));
          await intake({ Records: [{ s3: { object: { key } } }] });
          return { ok: true, status: 200 };
        }
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, token(sub));
        return json(r.status, r.body);
      };
    },
  });
  await wait(120);
  const w = dom.window, d = w.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const all = (sel) => [...d.querySelectorAll(sel)];
  return {
    w, d, el, all, puts,
    type: (sel, v) => { el(sel).value = v; },
    submit: async (sel) => { el(sel).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await wait(); },
    click: async (sel) => { el(sel).click(); await wait(); },
    texts: (sel) => all(sel).map((e) => e.textContent.trim()),
    close: () => w.close(),
  };
}

beforeEach(reset);

test('opens your own drawer, with its folders and files', async () => {
  await upload('mine', 'Insurance/Auto', [policy]);
  await upload('mine', '', [receipt]);
  const p = await open();
  assert.deepEqual(p.texts('[data-drawer]'), ['My drawer']);
  assert.equal(p.el('[data-drawer]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(p.texts('.row.folder > button'), ['Insurance']);
  assert.deepEqual(p.texts('.row:not(.folder) > button'), ['tires.txt']);
  await p.click('[data-folder="Insurance"]');
  await p.click('[data-folder="Insurance/Auto"]');
  assert.deepEqual(p.texts('.row:not(.folder) > button'), ['geico-renewal.pdf']);
  assert.deepEqual(p.texts('.crumbs button'), ['My drawer', 'Insurance', 'Auto']);
  p.close();
});

test('upload from the page: hashed, sent straight to S3 with the signed headers, filed', async () => {
  const p = await open();
  const input = p.el('[data-upload]');
  const file = new p.w.File([policy.bytes], 'policy.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait(400);
  assert.equal(p.puts.length, 1);
  assert.ok(p.puts[0].headers['x-amz-checksum-sha256']);
  assert.deepEqual(p.texts('.row:not(.folder) > button'), ['policy.pdf']);
  assert.match(p.el('.uploads').textContent, /filed/);
  // The same bytes again (the page drew a new input): already here, nothing sent
  const again = p.el('[data-upload]');
  Object.defineProperty(again, 'files', { value: [file] });
  again.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait(300);
  assert.equal(p.puts.length, 1);
  assert.match(p.el('.uploads').textContent, /already here/);
  p.close();
});

test('a file’s card: describe and move it; it lands where it was moved', async () => {
  await upload('mine', '', [policy]);
  const p = await open();
  await p.click('[data-file]');
  await p.click('[data-editfile]');
  p.type('form[data-form="file"] [name="title"]', 'Geico renewal');
  p.type('form[data-form="file"] [name="folder"]', 'Insurance/Auto');
  p.type('form[data-form="file"] [name="tags"]', 'car, Insurance');
  p.type('form[data-form="file"] [name="docDate"]', '2026-03-14');
  await p.submit('form[data-form="file"]');
  await wait(100);
  assert.equal(p.el('.card.file h2').textContent, 'Geico renewal');
  const { body } = await call('GET', '/files?q=geico');
  assert.equal(body.files[0].folder, 'Insurance/Auto');
  assert.deepEqual(body.files[0].tags, ['car', 'insurance']);
  p.close();
});

test('trash asks twice; the trash shows it; restore brings it back; the owner deletes for good', async () => {
  const id = (await upload('mine', '', [receipt])).body.files[0].id;
  const p = await open();
  await p.click(`[data-file="${id}"]`);
  await p.click('[data-trash]');
  assert.equal(p.el('[data-trash]').textContent, 'Trash it?');
  await p.click('[data-trash]');
  await wait(100);
  assert.equal(p.all('.row:not(.folder)').length, 0);
  await p.click('[data-trashview]');
  assert.deepEqual(p.texts('.row > button'), ['tires.txt']);
  await p.click(`[data-file="${id}"]`);
  await p.click('[data-forget]');
  await p.click('[data-forget]');
  await wait(100);
  assert.equal((await call('GET', `/files/${id}`)).status, 404);
  assert.equal(bucket.has(`f/${id}`), false);
  p.close();
});

test('make a drawer and share it with a group; the other person can file into it', async () => {
  await familyGroup('gparents0001', 'Parents', [LUKE, AMBER]);
  const p = await open();
  await p.click('[data-newdrawer]');
  p.type('form[data-form="new-drawer"] [name="name"]', 'Household');
  p.type('form[data-form="new-drawer"] [name="notes"]', 'Bills, the house, the cars.');
  await p.submit('form[data-form="new-drawer"]');
  await wait(100);
  assert.ok(p.texts('[data-drawer]').includes('Household'));
  assert.equal(p.el('.info').textContent, 'Bills, the house, the cars.');
  await p.click('[data-share]');
  p.el('form[data-form="share"] [name="who"]').value = 'group:gparents0001';
  await p.submit('form[data-form="share"]');
  await wait(100);
  assert.match(p.el('.shares').textContent, /Group “Parents” · can file/);
  p.close();
  const hers = await open(AMBER);
  assert.ok(hers.texts('[data-drawer]').includes('Household'));
  await hers.click([...hers.d.querySelectorAll('[data-drawer]')].find((b) => b.textContent === 'Household') && `[data-drawer="${hers.all('[data-drawer]').find((b) => b.textContent === 'Household').dataset.drawer}"]`);
  assert.ok(hers.d.querySelector('[data-upload]'), 'she can file into it');
  assert.equal(hers.d.querySelector('[data-share]'), null, 'only the owner shares');
  hers.close();
});

test('search reaches every drawer you can see, and opens what it finds', async () => {
  await upload('mine', 'Insurance', [policy]);
  const p = await open();
  p.type('form[data-form="search"] [name="q"]', 'geico');
  await p.submit('form[data-form="search"]');
  assert.deepEqual(p.texts('.row > button'), ['geico-renewal.pdf']);
  await p.click('.row > button');
  assert.ok(p.el('.card.file'));
  p.close();
});
