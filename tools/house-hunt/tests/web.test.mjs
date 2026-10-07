import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { call, memberToken, table } from './helpers/house-hunt-api.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '').replace('<script src="leaflet/leaflet.js"></script>', '').replace('<script src="sortable/Sortable.min.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

const LEAFLET = readFileSync(new URL('../web/leaflet/leaflet.js', import.meta.url), 'utf8');
const SORTABLE = readFileSync(new URL('../web/sortable/Sortable.min.js', import.meta.url), 'utf8');

async function open(name = 'Luke', { withMap = false, withSortable = false } = {}) {
  const libs = (withMap ? `<script>${LEAFLET}</script>` : '') + (withSortable ? `<script>${SORTABLE}</script>` : '');
  const html = HTML.replace('<script>\n(function () {', `${libs}\n<script>\n(function () {`);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://house-hunt.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom has no layout; Leaflet only draws pins on a map with a size
      if (withMap) {
        for (const [k, v] of [['clientWidth', 800], ['clientHeight', 440]]) Object.defineProperty(w.HTMLElement.prototype, k, { get: () => v });
        w.Element.prototype.scrollIntoView = () => {};
        w.HTMLCanvasElement.prototype.getContext = undefined; // jsdom claims canvas but can't draw; with neither SVG nor canvas the rings are skipped
      }
      w.FamilyAuth = { init: async () => ({ given_name: name }), accessToken: async () => memberToken(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined);
        return json(r.status, r.body);
      };
    },
  });
  await wait(80);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const fire = (sel, type) => el(sel).dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }));
  const type = (sel, v) => { el(sel).value = v; fire(sel, 'input'); };
  return {
    d, el, type, fire,
    w: dom.window,
    lst: (hood) => [...d.querySelectorAll(`ol.lst[data-lst="${hood}"] > li`)].map((li) => li.querySelector('.lmain a, .lmain .addr').textContent),
    names: (group) => [...d.querySelectorAll(`${group ? `[data-group="${group}"] ` : ''}.hood h3 .nm`)].map((h) => h.textContent),
    click: async (sel) => { el(sel).click(); await wait(); },
    submit: async (sel = 'form.edit') => { fire(sel, 'submit'); await wait(); },
    close: () => dom.window.close(),
  };
}

beforeEach(async () => {
  table.clear();
  await call('PUT', '/hoods/pf', { name: 'Pelham Falls', pool: 'Two pools', elementary: 'Woodland', middle: 'Riverside Middle', high: 'Riverside High', price: 510000, sales: 15, rev: 0 });
  await call('PUT', '/hoods/sf', { name: 'Sudduth Farms', pool: 'Junior Olympic pool', high: 'Riverside High', price: 330750, rev: 0 });
});

test('lists neighborhoods to explore cheapest first with price, pool and schools', async () => {
  const p = await open();
  assert.deepEqual(p.names('explore'), ['Sudduth Farms', 'Pelham Falls']);
  const pf = p.el('[data-hood="pf"]');
  assert.match(pf.querySelector('.price').textContent, /\$510,000/);
  assert.match(pf.querySelector('.price').textContent, /15 sales/);
  assert.match(pf.querySelector('.facts').textContent, /Woodland \/ Riverside Middle \/ Riverside High/);
  p.el('#sort').value = 'price-desc'; p.fire('#sort', 'change'); await wait();
  assert.deepEqual(p.names('explore'), ['Pelham Falls', 'Sudduth Farms']);
  assert.equal(p.d.getElementById('map-card').hidden, true, 'no map without Leaflet, and nothing breaks');
  p.close();
});

test('notes on a neighborhood save with the Save button, stamped with who saved', async () => {
  const p = await open('Amber');
  assert.equal(p.el('[data-save="pf"]').hidden, true);
  p.type('[data-notes="pf"]', 'HOA $650/yr');
  assert.equal(p.el('[data-save="pf"]').hidden, false);
  await p.click('[data-save="pf"]');
  const saved = (await call('GET', '/all')).body.hoods.find((h) => h.id === 'pf');
  assert.equal(saved.notes, 'HOA $650/yr');
  assert.equal(saved.updatedByName, 'Amber');
  assert.match(p.el('[data-hood="pf"] .save-row').textContent, /by Amber/);
  p.close();
});

test('leaving a notes box saves it, once even when Save is clicked too', async () => {
  const p = await open();
  p.type('[data-notes="NOTES"]', 'Need a fenced yard');
  p.fire('[data-notes="NOTES"]', 'focusout');
  p.el('[data-save="NOTES"]').click();
  await wait(60);
  const { notes } = (await call('GET', '/all')).body;
  assert.equal(notes.text, 'Need a fenced yard');
  assert.equal(notes.rev, 1, 'saved exactly once');
  assert.equal(p.d.querySelector('.conflict'), null);
  p.close();
});

test('if someone else saved first, their notes are shown and yours stay in the box', async () => {
  const p = await open('Luke');
  await call('PUT', '/hoods/pf', { name: 'Pelham Falls', high: 'Riverside High', price: 510000, rev: 1, notes: 'Amber: loved it', byName: 'Amber' });
  p.type('[data-notes="pf"]', 'Luke: too far from work');
  await p.click('[data-save="pf"]');
  assert.match(p.el('[data-hood="pf"] .conflict').textContent, /Amber saved notes.*Amber: loved it/s);
  assert.equal(p.el('[data-notes="pf"]').value, 'Luke: too far from work');
  await p.click('[data-save="pf"]');
  assert.equal((await call('GET', '/all')).body.hoods.find((h) => h.id === 'pf').notes, 'Luke: too far from work');
  assert.equal(p.d.querySelector('.conflict'), null);
  p.close();
});

const place = async (p, id, value) => { p.el(`[data-place="${id}"]`).value = value; p.fire(`[data-place="${id}"]`, 'change'); await wait(80); };
const ranks = async () => Object.fromEntries((await call('GET', '/all')).body.hoods.map((h) => [h.id, [h.status, h.rank]]));

test('shortlist: pick a rank, and the others renumber to make room', async () => {
  await call('PUT', '/hoods/bm', { name: 'Brushy Meadows', price: 528000, status: 'shortlist', rank: 1, rev: 0 });
  const p = await open();
  assert.deepEqual(p.names('shortlist'), ['Brushy Meadows']);
  await place(p, 'pf', '1');
  assert.deepEqual(await ranks(), { pf: ['shortlist', 1], bm: ['shortlist', 2], sf: ['explore', null] });
  assert.deepEqual(p.names('shortlist'), ['Pelham Falls', 'Brushy Meadows']);
  assert.equal(p.el('#hood-pf .rank').textContent, '1');
  await place(p, 'sf', '2');
  assert.deepEqual(await ranks(), { pf: ['shortlist', 1], sf: ['shortlist', 2], bm: ['shortlist', 3] });
  await place(p, 'pf', 'nogo');
  assert.deepEqual(await ranks(), { pf: ['nogo', null], sf: ['shortlist', 1], bm: ['shortlist', 2] });
  assert.deepEqual(p.names('nogo'), ['Pelham Falls']);
  assert.match(p.el('#hood-pf .meta').textContent, /Ruled out/);
  p.close();
});

test('details: facts, drive times, visit and why it doesn’t fit', async () => {
  await call('PUT', '/hoods/pf', { name: 'Pelham Falls', price: 510000, rev: 1, visited: 'Sep 26', fitNote: 'Pool not confirmed',
    facts: ['River path'], drives: [{ to: "Mom's house", min: 9, mi: 3.7 }] });
  await call('PUT', '/hoods/sf', { name: 'Sudduth Farms', price: 330750, rev: 1, visited: 'drove through' });
  const p = await open();
  assert.match(p.el('#hood-pf .meta').textContent, /Visited Sep 26/);
  assert.match(p.el('#hood-pf .tag.warn').textContent, /Pool not confirmed/);
  assert.match(p.el('#hood-sf .meta').textContent, /^drove through$/);
  assert.match(p.el('#hood-pf details').textContent, /River path/);
  assert.match(p.el('#hood-pf .drives').textContent, /Mom's house9 min · 3.7 mi/);
  assert.equal(p.d.querySelector('#hood-sf details'), null, 'no empty details section');
  p.close();
});

test('edit details: drive times and a map location as plain text', async () => {
  const p = await open();
  await p.click('[data-edit="sf"]');
  p.el('form.edit [name="drives"]').value = "Mom's house: 12 min, 5.3 mi\nAmber's cheer gym: 8 mins";
  p.el('form.edit [name="ll"]').value = 'https://www.google.com/maps/place/x/@34.9002,-82.2311,15z';
  p.el('form.edit [name="facts"]').value = 'Junior Olympic pool\n\nPavilion with fireplace';
  await p.submit();
  const sf = (await call('GET', '/all')).body.hoods.find((h) => h.id === 'sf');
  assert.deepEqual(sf.drives, [{ to: "Mom's house", min: 12, mi: 5.3 }, { to: "Amber's cheer gym", min: 8, mi: null }]);
  assert.deepEqual(sf.ll, [34.9002, -82.2311]);
  assert.deepEqual(sf.facts, ['Junior Olympic pool', 'Pavilion with fireplace']);
  await p.click('[data-edit="sf"]');
  p.el('form.edit [name="drives"]').value = 'Mom: about ten minutes';
  await p.submit();
  assert.match(p.el('#status').textContent, /Couldn’t read “Mom: about ten minutes”/);
  p.el('form.edit [name="drives"]').value = '';
  p.el('form.edit [name="ll"]').value = 'near the lake';
  await p.submit();
  assert.match(p.el('#status').textContent, /Location should look like/);
  p.close();
});

test('add a neighborhood: price accepts $ and commas, bad numbers are refused', async () => {
  const p = await open();
  await p.click('#add');
  p.el('form.edit [name="name"]').value = 'Brushy Meadows';
  p.el('form.edit [name="price"]').value = '45k';
  await p.submit();
  assert.match(p.el('#status').textContent, /whole dollars/);
  p.el('form.edit [name="price"]').value = '$528,000';
  await p.submit();
  const added = (await call('GET', '/all')).body.hoods.find((h) => h.name === 'Brushy Meadows');
  assert.equal(added.price, 528000);
  assert.equal(added.status, 'explore');
  assert.deepEqual(p.names('explore'), ['Sudduth Farms', 'Pelham Falls', 'Brushy Meadows']);
  p.close();
});

test('edit details keeps notes; delete asks to confirm', async () => {
  await call('PUT', '/hoods/sf', { name: 'Sudduth Farms', high: 'Riverside High', price: 330750, rev: 1, notes: 'keep me' });
  const p = await open();
  await p.click('[data-edit="sf"]');
  p.el('form.edit [name="price"]').value = '335000';
  await p.submit();
  const sf = (await call('GET', '/all')).body.hoods.find((h) => h.id === 'sf');
  assert.deepEqual([sf.price, sf.notes], [335000, 'keep me']);
  await p.click('[data-del="sf"]');
  assert.equal((await call('GET', '/all')).body.hoods.length, 2, 'first click only arms');
  await p.click('[data-del="sf"]');
  assert.deepEqual((await call('GET', '/all')).body.hoods.map((h) => h.id), ['pf']);
  p.close();
});

test('names and notes are shown as text, never as markup', async () => {
  await call('PUT', '/hoods/x', { name: '<img src=x onerror=alert(1)>', notes: '</textarea><b>hi</b>', rev: 0 });
  const p = await open();
  assert.equal(p.d.querySelector('.hood img'), null);
  assert.equal(p.el('[data-notes="x"]').value, '</textarea><b>hi</b>');
  p.close();
});

test('the map pins neighborhoods and places, and lists what has no location yet', async () => {
  await call('PUT', '/hoods/pf', { name: 'Pelham Falls', price: 510000, rev: 1, status: 'shortlist', rank: 1, ll: [34.8495, -82.2227] });
  table.put({ pk: 'TOOL', sk: 'PLACE#gsp', kind: 'airport', name: 'GSP International Airport', note: '', ll: [34.8954, -82.2172] });
  table.put({ pk: 'TOOL', sk: 'PLACE#mom', kind: 'family', name: "Mom's house", note: '', ll: null });
  const p = await open('Luke', { withMap: true });
  assert.equal(p.d.getElementById('map-card').hidden, false);
  assert.equal(p.d.querySelector('.pin.shortlist').textContent, '1');
  assert.ok(p.d.querySelector('.pin.airport'));
  assert.equal(p.d.querySelectorAll('.ring-label').length, 3);
  assert.match(p.el('#unpinned').textContent, /Sudduth Farms, Mom's house/);
  assert.ok(p.d.querySelector('[data-show="pf"]'), 'pinned neighborhoods get Show on map');
  assert.equal(p.d.querySelector('[data-show="sf"]'), null);
  p.close();
});

test('show on map: a listing’s address or a typed one gets a pin, with how exact it is and the closest neighborhood', async () => {
  await call('PUT', '/hoods/pf', { name: 'Pelham Falls', price: 510000, rev: 1, ll: [34.8495, -82.2227] });
  await call('PUT', '/listings/a', { address: '12 Sugar Lake Ct', city: 'Taylors', hoodId: 'pf', price: 615000, url: 'https://www.zillow.com/a', rev: 0 });
  const real = globalThis.fetch, asked = [];
  // The API's geocoders: Census knows Sugar Lake; OpenStreetMap only knows the street of Algeddis; nothing else exists
  globalThis.fetch = async (url) => {
    const u = new URL(url), q = u.searchParams.get('address') || u.searchParams.get('q');
    asked.push(q);
    const census = /Sugar Lake/.test(q) ? [{ matchedAddress: '12 SUGAR LAKE CT, TAYLORS, SC', coordinates: { x: -82.2227, y: 34.8640 } }] : [];
    const osm = /Algeddis/.test(q) ? [{ lat: '34.8812', lon: '-82.1778', addresstype: 'road', display_name: 'Algeddis Drive' }] : [];
    return { ok: true, status: 200, json: async () => (u.host.startsWith('geocoding') ? { result: { addressMatches: census } } : osm) };
  };
  try {
    const p = await open('Luke', { withMap: true });
    await p.click('[data-lmap="a"]'); await wait(1000);
    assert.equal(asked[0], '12 Sugar Lake Ct, Taylors, SC');
    let pop = p.el('.leaflet-popup-content').textContent;
    assert.match(pop, /12 Sugar Lake Ct\$615,000 · Listing12 SUGAR LAKE CT, TAYLORS, SC/);
    assert.match(pop, /Closest neighborhood pin: Pelham Falls, 1\.0 mi/);
    assert.equal(p.d.querySelectorAll('.pin.found').length, 1);

    p.el('#find input').value = '1317 Algeddis Dr'; p.fire('#find', 'submit'); await wait(1000);
    assert.equal(asked.at(-1), '1317 Algeddis Dr, Greer, SC', 'no town given: Greer');
    pop = p.el('.leaflet-popup-content').textContent;
    assert.match(pop, /1317 Algeddis DrOnly the street is mapped, not the house/);
    assert.equal(p.d.querySelectorAll('.pin.found').length, 1, 'one pin at a time');

    p.el('#find input').value = 'Nowhere Ln, Atlantis'; p.fire('#find', 'submit'); await wait();
    assert.match(p.el('#status').textContent, /Couldn’t find “Nowhere Ln, Atlantis” on the map/);
    p.close();
  } finally { globalThis.fetch = real; }
});

const L = (id, o = {}) => call('PUT', `/listings/${id}`, { address: `${id} Main St`, hoodId: 'pf', price: 500000, rank: 1, rev: 0, reviewed: true, ...o });
const rows = async () => Object.fromEntries((await call('GET', '/all')).body.listings.map((l) => [l.id, [l.hoodId, l.rank]]));

test('listings show ranked inside their neighborhood, with what’s new; unsorted ones and recent emails in the inbox', async () => {
  await L('a', { rank: 2, reviewed: false, beds: 4, baths: 2.5, url: 'https://www.zillow.com/a' });
  await L('b', { rank: 1, history: [{ at: '2026-10-01T00:00:00Z', kind: 'new', price: 520000 }, { at: '2026-10-04T00:00:00Z', kind: 'price_cut', price: 500000 }], event: 'price_cut' });
  await L('c', { hoodId: null, rank: 1, status: 'pending' });
  table.put({ pk: 'TOOL', sk: 'MAIL#2026-10-05T12:00:00Z#m', receivedAt: '2026-10-05T12:00:00Z', subject: 'New listings', outcome: 'ok', added: 2, updated: 1 });
  const p = await open();
  assert.deepEqual(p.lst('pf'), ['b Main St', 'a Main St']);
  assert.match(p.el('[data-listing="a"]').textContent, /New.*4 bd · 2.5 ba/);
  assert.equal(p.el('[data-listing="a"] .lmain a').getAttribute('href'), 'https://www.zillow.com/a');
  assert.match(p.el('[data-listing="b"] .ltag.cut').textContent, /Price cut \$20,000/);
  assert.match(p.el('#hood-pf .listings-head').textContent, /Listings · 2 · 1 to review/);
  assert.deepEqual(p.lst(''), ['c Main St']);
  assert.match(p.el('.inbox').textContent, /househunt@dot-y\.co/);
  assert.match(p.el('.mail-log').textContent, /New listings · 2 new, 1 updated/);
  assert.match(p.el('[data-listing="c"] .ltag.pending').textContent, /Pending/);
  p.close();
});

test('rank listings with ↑ ↓, and move one to another neighborhood (it joins the bottom)', async () => {
  await L('a', { rank: 1 }); await L('b', { rank: 2 }); await L('c', { rank: 3 });
  await L('x', { hoodId: 'sf', rank: 1 });
  const p = await open();
  await p.click('[data-lmove="c"][data-dir="-1"]'); await wait(60);
  assert.deepEqual(await rows(), { a: ['pf', 1], c: ['pf', 2], b: ['pf', 3], x: ['sf', 1] });
  assert.deepEqual(p.lst('pf'), ['a Main St', 'c Main St', 'b Main St']);
  p.el('[data-lhood="a"]').value = 'sf'; p.fire('[data-lhood="a"]', 'change'); await wait(80);
  assert.deepEqual(await rows(), { a: ['sf', 2], c: ['pf', 1], b: ['pf', 2], x: ['sf', 1] });
  p.el('[data-lhood="x"]').value = ''; p.fire('[data-lhood="x"]', 'change'); await wait(80);
  assert.deepEqual((await rows()).x, [null, 1]);
  assert.deepEqual(p.lst(''), ['x Main St'], 'the inbox shows it once something is unsorted');
  p.close();
});

test('reject a listing: it drops out of its list and the counts, and can be shown and un-rejected', async () => {
  await L('a', { rank: 1, reviewed: false });
  await L('b', { rank: 2 });
  const p = await open('Luke');
  assert.deepEqual(p.lst('pf'), ['a Main St', 'b Main St']);
  await p.click('[data-lreject="a"]');
  assert.equal((await call('GET', '/all')).body.listings.find((l) => l.id === 'a').rejected, true);
  assert.deepEqual(p.lst('pf'), ['b Main St']);
  assert.doesNotMatch(p.el('#hood-pf .listings-head').textContent, /to review/);
  assert.match(p.el('.inbox').textContent, /1 rejected listing hidden/);
  assert.match(p.el('#status').textContent, /a Main St rejected/);

  await p.click('[data-showrejected]');
  assert.deepEqual(p.lst('pf'), ['a Main St', 'b Main St']);
  assert.ok(p.el('[data-listing="a"]').classList.contains('rejected'));
  assert.match(p.el('[data-listing="a"]').textContent, /Rejected/);
  await p.click('[data-lreject="a"]');
  assert.equal((await call('GET', '/all')).body.listings.find((l) => l.id === 'a').rejected, false);
  assert.equal(p.d.querySelector('[data-showrejected]'), null, 'nothing rejected, no toggle');
  p.close();
});

test('add a listing by hand, mark one reviewed, keep notes on it, and delete it', async () => {
  await L('a', { reviewed: false });
  const p = await open('Amber');
  await p.click('#hood-sf [data-ladd="sf"]');
  p.el('form.ladd [name="address"]').value = '7 Pond View Ct';
  p.el('form.ladd [name="price"]').value = '$449,000';
  p.el('form.ladd [name="url"]').value = 'redfin.com/home/7';
  await p.submit('form.ladd'); await wait(40);
  const added = (await call('GET', '/all')).body.listings.find((l) => l.address === '7 Pond View Ct');
  assert.deepEqual([added.hoodId, added.price, added.url, added.rank, added.source], ['sf', 449000, 'https://redfin.com/home/7', 1, 'manual']);
  await p.click('[data-lreview="a"]');
  assert.equal((await call('GET', '/all')).body.listings.find((l) => l.id === 'a').reviewed, true);
  assert.match(p.el('[data-lreview="a"]').textContent, /✓ Reviewed/);
  await p.click('[data-lnotes="a"]');
  p.type('[data-notes="L:a"]', 'Showing Saturday');
  await p.click('[data-save="L:a"]');
  const a = (await call('GET', '/all')).body.listings.find((l) => l.id === 'a');
  assert.deepEqual([a.notes, a.updatedByName], ['Showing Saturday', 'Amber']);
  await p.click('[data-ldel="a"]'); await p.click('[data-ldel="a"]');
  assert.equal((await call('GET', '/all')).body.listings.some((l) => l.id === 'a'), false);
  p.close();
});

test('dragging: a neighborhood dropped into the shortlist takes that rank; a listing dropped elsewhere moves there', async () => {
  await call('PUT', '/hoods/bm', { name: 'Brushy Meadows', price: 528000, status: 'shortlist', rank: 1, rev: 0 });
  await L('a', { rank: 1 }); await L('b', { hoodId: 'sf', rank: 1 });
  const p = await open('Luke', { withSortable: true });
  const S = p.w.Sortable;
  const shortlist = p.el('[data-cards="shortlist"]'), explore = p.el('[data-cards="explore"]');
  // Sortable has moved the card; this is the drop it reports
  S.get(shortlist).options.onEnd({ item: p.el('#hood-sf'), from: explore, to: shortlist, newDraggableIndex: 0 });
  await wait(80);
  assert.deepEqual(await ranks(), { bm: ['shortlist', 2], sf: ['shortlist', 1], pf: ['explore', null] });
  const pfList = p.el('ol.lst[data-lst="pf"]'), sfList = p.el('ol.lst[data-lst="sf"]');
  S.get(pfList).options.onEnd({ item: p.el('[data-listing="a"]'), from: pfList, to: sfList, oldIndex: 0, newIndex: 0 });
  await wait(80);
  assert.deepEqual(await rows(), { a: ['sf', 1], b: ['sf', 2] });
  assert.equal(p.d.querySelectorAll('.hood-head .drag').length, 3, 'every neighborhood has a handle');
  p.close();
});
