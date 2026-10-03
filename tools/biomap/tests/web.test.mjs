// The flashcards app in jsdom: signs in, loads the deck and progress from the API, syncs grades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DECK = {
  inbox: 0, rank_order: ['Site', 'Kingdom'],
  taxa: [
    { id: 's', name: '1, 2', rank: 'Site', not_a_taxon: true, path: 's', depth: 0, ancestors: [], branch: 'Overview', common_name: 'Test Park' },
    { id: 'f', name: 'Fungi', rank: 'Kingdom', path: 's/E/Fungi', depth: 2, ancestors: ['E'], branch: 'Fungi', image_path: 's/E/Fungi/x.jpg' },
  ],
  cards: [
    { id: 'f::rank', type: 'rank', front: 'What taxonomic rank is **Fungi**?', back: { kind: 'text', text: 'Kingdom' }, taxon: 'Fungi', taxonId: 'f', rank: 'Kingdom', branch: 'Fungi', path: 's/E/Fungi', image: null },
    { id: 'f::photo', type: 'photo', front: 'Identify this specimen.', back: { kind: 'text', text: 'Fungi' }, taxon: 'Fungi', taxonId: 'f', rank: 'Kingdom', branch: 'Fungi', path: 's/E/Fungi', image: 's/E/Fungi/x.jpg' },
  ],
};

async function open({ server = null, local = null, puts = [], putReplies = [] } = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://biomap.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      if (local) w.localStorage.setItem('biomap.progress.v1', JSON.stringify(local));
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => 'tok', autoLogin: () => false, login() {}, logout() {} };
      w.confirm = () => true;
      w.fetch = async (url, o = {}) => {
        const res = (status, body) => ({ ok: status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
        if (url === 'config.json') return res(200, { apiUrl: 'https://api.test' });
        if (url.endsWith('/deck')) return res(200, { ...DECK, images: { 's/E/Fungi/x.jpg': 'https://signed.example/x.jpg?sig=1' } });
        if (url.endsWith('/progress') && (o.method || 'GET') === 'GET') return server ? res(200, server) : res(404, {});
        if (url.endsWith('/progress')) { const b = JSON.parse(o.body); puts.push(b); return res(...(putReplies.shift() || [200, { rev: (b.rev ?? 0) + 1 }])); }
        throw new Error('unexpected ' + url);
      };
    },
  });
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await wait(50);
  return { dom, d: dom.window.document, w: dom.window, puts };
}

test('loads the deck from the API and shows study cards; photos use the signed URLs', async () => {
  const { d, dom } = await open();
  assert.ok(d.getElementById('studyStage').textContent.length > 0, 'study view rendered');
  assert.match(d.getElementById('coord').textContent, /Test Park/);
  d.getElementById('tab-collection').click();
  const imgs = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src'));
  d.querySelector('[data-id="f"], [data-taxon="f"], .tree-row')?.click?.();
  await wait(10);
  const all = [...d.querySelectorAll('img')].map((i) => i.getAttribute('src')).concat(imgs);
  assert.ok(all.every((s) => !s || s.startsWith('https://signed.example/')), 'no raw collection paths');
  assert.equal(d.querySelector('[data-theme]'), null);
  dom.window.close();
});

test('starts from your synced progress, merged with anything only this browser had', async () => {
  const server = { progress: { cards: { 'f::rank': { reps: 3, due: 9e12, ease: 2.5, interval: 20 } }, days: { '2026-10-01': 4 } }, rev: 7 };
  const local = { cards: { 'f::rank': { reps: 1, due: 1 }, 'f::photo': { reps: 2, due: 5 } }, days: { '2026-10-02': 2 }, filters: {} };
  const { w, puts, dom } = await open({ server, local });
  const stored = JSON.parse(w.localStorage.getItem('biomap.progress.v1'));
  assert.equal(stored.cards['f::rank'].reps, 3, 'more-reviewed copy wins');
  assert.equal(stored.cards['f::photo'].reps, 2, 'local-only card kept');
  assert.deepEqual(stored.days, { '2026-10-01': 4, '2026-10-02': 2 });
  await wait(1700);
  assert.equal(puts.length, 1, 'the merged history is uploaded');
  assert.equal(puts[0].rev, 7);
  assert.equal(puts[0].progress.cards['f::photo'].reps, 2);
  dom.window.close();
});

test('a conflicting save from another device is merged, not overwritten', async () => {
  const other = { cards: { 'f::other': { reps: 5, due: 99 } }, days: {} };
  const { w, puts, dom } = await open({ local: { cards: { 'f::photo': { reps: 1, due: 1 } }, days: {} }, putReplies: [[409, { progress: other, rev: 4 }]] });
  await wait(2200);
  assert.equal(puts.length, 2);
  assert.equal(puts[1].rev, 4);
  assert.deepEqual(Object.keys(puts[1].progress.cards).sort(), ['f::other', 'f::photo']);
  void w;
  dom.window.close();
});
