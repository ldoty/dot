// The page in jsdom: signs in, loads the guide and progress from the API, drills flashcards and saves
// what you know, and draws the plan, people, overlap and organizations from the guide (an invented fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const GUIDE = JSON.parse(readFileSync(new URL('./guide.fixture.json', import.meta.url), 'utf8'));
const KEY = 'boards-v1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ server = null, status = 200 } = {}) {
  const puts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://boards.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 'l' }), accessToken: async () => 'tok', autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const res = (s, body) => ({ ok: s < 300, status: s, json: async () => JSON.parse(JSON.stringify(body)) });
        if (url === 'config.json') return res(200, { apiUrl: 'https://api.test' });
        if (url.endsWith('/guide')) return res(status, status === 200 ? { guide: GUIDE } : {});
        if (url.endsWith('/progress') && (o.method || 'GET') === 'GET') return server ? res(200, { progress: server }) : res(404, {});
        if (url.endsWith('/progress')) { puts.push(JSON.parse(o.body)); return res(200, {}); }
        throw new Error('unexpected ' + url);
      };
    },
  });
  await wait(50);
  return { dom, d: dom.window.document, w: dom.window, puts };
}
const tab = (d, name) => d.querySelector(`nav.tabs [data-tab="${name}"]`).click();

test('the public page has nothing about the people or the organizations', () => {
  for (const s of ['Ada North', 'Alpha', 'Northwind']) assert.ok(!HTML.includes(s));
  // With the real guide built locally, check none of its names or orgs leaked into the page.
  const real = new URL('../private/guide.json', import.meta.url);
  if (existsSync(real)) {
    const g = JSON.parse(readFileSync(real, 'utf8'));
    for (const p of g.people) assert.ok(!HTML.includes(p.name), `${p.name} is in web/index.html`);
    for (const o of g.orgs) assert.ok(!HTML.includes(o.short), `${o.short} is in web/index.html`);
  }
});

test('loads the guide and opens on the faces deck', async () => {
  const { d, dom } = await open();
  assert.match(d.getElementById('counts').textContent, /4 Alpha.*4 Beta.*2 bridges/);
  assert.equal(d.getElementById('tab-study').hidden, false);
  assert.equal(d.querySelectorAll('.choice').length, 4, 'four people in scope have photos');
  assert.match(d.getElementById('legend').textContent, /0 known.*4 new or missed/);
  dom.window.close();
});

test('a right answer moves the card up and saves to your account', async () => {
  const { d, w, puts, dom } = await open();
  const name = d.querySelector('.face.front img').alt;
  [...d.querySelectorAll('.choice')].find((c) => c.dataset.o === name).click();
  assert.equal(d.getElementById('fb').textContent, 'Right.');
  await wait(1200);
  const last = puts.at(-1).progress;
  assert.equal(last.boxes['face:' + GUIDE.people.find((p) => p.name === name).id], 1);
  assert.equal(JSON.parse(w.localStorage.getItem(KEY)).boxes['face:' + GUIDE.people.find((p) => p.name === name).id], 1);
  assert.equal(d.getElementById('sync').textContent, 'Saved to your account');
  dom.window.close();
});

test('a wrong answer sends the card back to the start', async () => {
  const { d, puts, dom } = await open({ server: { boxes: { 'face:ada-north': 3, 'face:cal-reyes': 3, 'face:eli-moss': 3, 'face:dee-park': 3 } } });
  const name = d.querySelector('.face.front img').alt;
  [...d.querySelectorAll('.choice')].find((c) => c.dataset.o !== name).click();
  assert.match(d.getElementById('fb').textContent, new RegExp(`It’s ${name}`));
  assert.ok(d.querySelector('.choice.right') && d.querySelector('.choice.wrong'));
  await wait(1200);
  assert.equal(puts.at(-1).progress.boxes['face:' + GUIDE.people.find((p) => p.name === name).id], 0);
  dom.window.close();
});

test('the which-org deck hides the org names in its questions', async () => {
  const { d, dom } = await open({ server: { study: { deck: 'orgs', scope: 'all', mode: 'choose' } } });
  assert.deepEqual([...d.querySelectorAll('.choice')].map((c) => c.dataset.o), ['Alpha', 'Beta', 'Both']);
  for (let i = 0; i < 12; i++) {
    const q = d.querySelector('.face.front .q').textContent;
    assert.ok(!/Alpha|Beta/.test(q), q);
    assert.ok(!q.includes('____ Summit'), 'the longer alias goes first');
    d.querySelector('.choice').click(); d.getElementById('nextBtn').click();
  }
  dom.window.close();
});

test('the Partner Track deck accepts any of a person’s tags', async () => {
  const { d, dom } = await open({ server: { study: { deck: 'lens', scope: 'all', mode: 'choose' } } });
  for (let i = 0; i < 6; i++) {
    const who = d.querySelector('.face.front .q').textContent;
    const pick = who === 'Ada North' ? 'Exited founder' : 'Future LP or anchor';
    d.querySelector(`.choice[data-o="${pick}"]`).click();
    assert.match(d.getElementById('fb').textContent, /^Right/);
    d.getElementById('nextBtn').click();
  }
  dom.window.close();
});

test('flip cards grade with the keyboard', async () => {
  const { d, w, puts, dom } = await open({ server: { study: { deck: 'bridges', scope: 'all', mode: 'choose' } } });
  assert.ok(d.getElementById('gradeBtns'), 'bridges are always flip cards');
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.ok(d.getElementById('flash').classList.contains('flipped'));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  await wait(1200);
  assert.equal(Object.values(puts.at(-1).progress.boxes)[0], 1);
  dom.window.close();
});

test('people: filters, search and a profile with its ties', async () => {
  const { d, w, puts, dom } = await open({ server: { tab: 'people' } });
  assert.equal(d.getElementById('tab-people').hidden, false, 'reopens the last tab');
  assert.equal(d.querySelectorAll('.pcard').length, 8);
  d.querySelector('[data-pf="bridge"]').click();
  assert.deepEqual([...d.querySelectorAll('.pcard .nm')].map((n) => n.textContent), ['Ada North', 'Ben North']);
  d.querySelector('[data-lf="lp"]').click();
  assert.deepEqual([...d.querySelectorAll('.pcard .nm')].map((n) => n.textContent), ['Ben North']);
  d.querySelector('[data-lf="lp"]').click(); d.querySelector('[data-pf="all"]').click();
  const q = d.getElementById('q'); q.value = 'river club'; q.dispatchEvent(new w.Event('input'));
  assert.deepEqual([...d.querySelectorAll('.pcard .nm')].map((n) => n.textContent), ['Ada North']);
  d.querySelector('.pcard').click();
  assert.equal(d.getElementById('sheetBg').hidden, false);
  assert.match(d.getElementById('sheet').textContent, /Married to Ben North/);
  assert.match(d.getElementById('sheet').textContent, /Writes angel checks/);
  await wait(1200);
  assert.equal(puts.at(-1).progress.pfilter, 'all');
  dom.window.close();
});

test('plan, overlap and organizations come from the guide', async () => {
  const { d, dom } = await open();
  tab(d, 'plan');
  assert.match(d.getElementById('plan').textContent, /Alpha now, Beta later/);
  assert.ok(d.querySelector('#plan .faces [data-person="dee-park"]'));
  tab(d, 'overlap');
  assert.equal(d.querySelector('#bridges h3').textContent, 'The Norths', 'strongest first');
  assert.ok(d.querySelector('#bridges [data-person="ben-north"]'), 'names become profile links');
  assert.match(d.getElementById('sponsorCols').textContent, /Alpha only.*Reyes Capital.*Both.*Oak Bank/);
  tab(d, 'orgs');
  assert.equal(d.querySelectorAll('#orgs .org').length, 2);
  dom.window.close();
});

test('tells non-members they lack access', async () => {
  const { d, dom } = await open({ status: 403 });
  assert.match(d.getElementById('gate-msg').textContent, /doesn’t have access/);
  dom.window.close();
});
