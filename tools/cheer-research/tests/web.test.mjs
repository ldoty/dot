// The page in jsdom: signs in, loads the guide and progress from the API, drills flashcards and saves
// what you know, and draws the guide, players, money flows, calculator and questions from an invented fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const GUIDE = JSON.parse(readFileSync(new URL('./guide.fixture.json', import.meta.url), 'utf8'));
const KEY = 'cheer-research-v1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ server = null, status = 200 } = {}) {
  const puts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://cheer-research.dot-y.co/', pretendToBeVisual: true,
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
const type = (d, w, k, v) => { const el = d.querySelector(`[data-k="${k}"]`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

test('the public page has none of the research', () => {
  for (const s of ['Acme Events', 'Widget Guild', 'Bigfund']) assert.ok(!HTML.includes(s));
  // With the real guide built locally, check none of its players or cards leaked into the page.
  const real = new URL('../private/guide.json', import.meta.url);
  if (existsSync(real)) {
    const g = JSON.parse(readFileSync(real, 'utf8'));
    for (const p of g.players) assert.ok(!HTML.includes(p.name), `${p.name} is in web/index.html`);
    for (const c of g.cards) assert.ok(!HTML.includes(c.q), `card “${c.q}” is in web/index.html`);
  }
});

test('opens on the study deck with four choices', async () => {
  const { d, dom } = await open();
  assert.equal(d.getElementById('tab-study').hidden, false);
  assert.equal(d.querySelectorAll('.choice').length, 4);
  assert.match(d.getElementById('legend').textContent, /0 known.*6 new or missed/);
  assert.deepEqual([...d.querySelectorAll('#deckChips .chip')].map((c) => c.textContent), ['Everything', 'Alpha chapter', 'Beta chapter', 'Who owns it?'], 'chapters without cards get no deck');
  dom.window.close();
});

test('a right answer moves the card up and saves to your account', async () => {
  const { d, w, puts, dom } = await open();
  const q = d.querySelector('.face.front .q').textContent;
  const card = GUIDE.cards.find((c) => c.q === q);
  d.querySelector(`.choice[data-o="${card.a}"]`).click();
  assert.equal(d.getElementById('fb').textContent, 'Right.');
  await wait(1200);
  assert.equal(puts.at(-1).progress.boxes[card.id], 1);
  assert.equal(JSON.parse(w.localStorage.getItem(KEY)).boxes[card.id], 1);
  assert.equal(d.getElementById('sync').textContent, 'Saved to your account');
  dom.window.close();
});

test('a wrong answer sends the card back to the start', async () => {
  const boxes = Object.fromEntries(GUIDE.cards.map((c) => [c.id, 3]));
  const { d, puts, dom } = await open({ server: { boxes } });
  const card = GUIDE.cards.find((c) => c.q === d.querySelector('.face.front .q').textContent);
  [...d.querySelectorAll('.choice')].find((c) => c.dataset.o !== card.a).click();
  assert.equal(d.getElementById('fb').textContent, `It’s ${card.a}.`);
  await wait(1200);
  assert.equal(puts.at(-1).progress.boxes[card.id], 0);
  dom.window.close();
});

test('the owners deck asks who owns each player, skipping generic owners', async () => {
  const { d, dom } = await open({ server: { study: { deck: 'owners', mode: 'choose' } } });
  for (let i = 0; i < 8; i++) {
    const name = d.querySelector('.face.front .q').textContent;
    assert.notEqual(name, 'Widget Guild', 'a nonprofit owner isn’t a card');
    const p = GUIDE.players.find((x) => x.name === name);
    d.querySelector(`.choice[data-o="${p.owner}"]`).click();
    assert.equal(d.getElementById('fb').textContent, 'Right.');
    d.getElementById('nextBtn').click();
  }
  dom.window.close();
});

test('flip cards grade with the keyboard', async () => {
  const { d, w, puts, dom } = await open({ server: { study: { deck: 'beta', mode: 'flip' } } });
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.ok(d.getElementById('flash').classList.contains('flipped'));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: '2', bubbles: true }));
  await wait(1200);
  assert.equal(Object.values(puts.at(-1).progress.boxes)[0], 1);
  dom.window.close();
});

test('the guide shows the thesis and labeled chapters with sources', async () => {
  const { d, dom } = await open();
  tab(d, 'guide');
  assert.match(d.querySelector('.thesis').textContent, /Follow the widgets.*Payments.*Before the widget season/);
  assert.equal(d.querySelectorAll('.chapter').length, 3);
  const first = d.querySelector('#ch-alpha .points li');
  assert.equal(first.querySelector('.tag').textContent, 'C');
  assert.equal(first.querySelector('.src a').textContent, 'example.com');
  dom.window.close();
});

test('players filter by kind, role and search', async () => {
  const { d, w, puts, dom } = await open({ server: { tab: 'players' } });
  assert.equal(d.getElementById('tab-players').hidden, false, 'reopens the last tab');
  assert.equal(d.querySelectorAll('.player').length, 5);
  d.querySelector('[data-kind="software"]').click();
  assert.deepEqual([...d.querySelectorAll('.player h3')].map((n) => n.textContent), ['Zed Software']);
  d.querySelector('[data-kind="software"]').click();
  d.querySelector('[data-role="prospect"]').click();
  assert.deepEqual([...d.querySelectorAll('.player h3')].map((n) => n.textContent), ['Omega Roll-up']);
  d.querySelector('[data-role="prospect"]').click();
  const q = d.getElementById('q'); q.value = 'bigfund'; q.dispatchEvent(new w.Event('input'));
  assert.deepEqual([...d.querySelectorAll('.player h3')].map((n) => n.textContent), ['Acme Events']);
  await wait(1200);
  assert.equal(puts.at(-1).progress.prole, '');
  dom.window.close();
});

test('money: flows by segment, and the calculator adds up the legs', async () => {
  const { d, w, puts, dom } = await open();
  tab(d, 'money');
  assert.equal(d.querySelectorAll('#flowRows tr').length, 3, 'all-star flows first');
  d.querySelector('[data-seg="dance"]').click();
  assert.equal(d.querySelectorAll('#flowRows tr').length, 1);
  // 100 athletes × ($2,000 + $1,000) through the platform; hotels are low-capture and start unticked.
  let r = w.researchCompute();
  assert.equal(r.spend, 450000);
  assert.equal(r.volume, 300000);
  assert.equal(r.legs.payments, 900);      // half card at 0.5%, half ACH at 0.1%
  assert.equal(r.legs.texting, 240);       // 100 families × 10 texts × 12 months × 2¢ margin
  assert.equal(r.legs.marketing, 1200);
  assert.equal(r.legs.ai, 500);
  assert.equal(d.getElementById('total').textContent, '$2,840');
  assert.equal(d.getElementById('market').textContent, '$284k');
  type(d, w, 'websitesMonthly', '50');
  assert.equal(w.researchCompute().legs.websites, 600);
  assert.equal(d.getElementById('total').textContent, '$3,440');
  type(d, w, 'parentFee', '1');
  assert.equal(w.researchCompute().legs.fee, 3000);
  d.querySelector('[data-inc="h"]').click();
  r = w.researchCompute();
  assert.equal(r.volume, 450000, 'ticking hotels adds them');
  d.querySelector('[data-level="high"]').click();
  assert.equal(w.researchCompute().volume, 750000);
  await wait(1200);
  const saved = puts.at(-1).progress.calc;
  assert.equal(saved.parentFee, 1);
  assert.equal(saved.include.h, true);
  assert.equal(saved.level, 'high');
  d.getElementById('calcReset').click();
  assert.equal(w.researchCompute().volume, 300000);
  assert.equal(d.querySelector('[data-k="parentFee"]').value, '0');
  dom.window.close();
});

test('saved calculator inputs come back, and new defaults still apply', async () => {
  const { d, w, dom } = await open({ server: { tab: 'money', calc: { cardShare: 100, athletes: { allstar: 10 }, outcomes: [{ id: 'enroll', count: 2, price: 50 }], gone: 1 } } });
  assert.equal(d.querySelector('[data-k="cardShare"]').value, '100');
  assert.equal(d.querySelector('[data-k="athletes.allstar"]').value, '10');
  assert.equal(d.querySelector('[data-k="marketingMonthly"]').value, '100', 'unsaved fields keep the guide default');
  assert.equal(w.researchCompute().legs.ai, 100);
  dom.window.close();
});

test('questions to ask are grouped by who, and ticking one is saved', async () => {
  const { d, w, puts, dom } = await open({ server: { tab: 'ask' } });
  assert.deepEqual([...d.querySelectorAll('#asks h2')].map((h) => h.textContent), ['First client', 'Omega']);
  const box = d.querySelector('#asks input[type=checkbox]');
  box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match(d.querySelector('#asks .section-h').textContent, /1 of 2 asked/);
  await wait(1200);
  assert.deepEqual(puts.at(-1).progress.asked, { 'What’s your card share?': true });
  dom.window.close();
});

test('timing shows the calendar', async () => {
  const { d, dom } = await open();
  tab(d, 'timing');
  assert.match(d.getElementById('timing').textContent, /May.*Tryouts.*Recitals.*Sell now.*Widget season opens in May/);
  dom.window.close();
});

test('tells non-members they lack access', async () => {
  const { d, dom } = await open({ status: 403 });
  assert.match(d.getElementById('gate-msg').textContent, /doesn’t have access/);
  dom.window.close();
});
