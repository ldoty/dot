import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { call, memberToken, table } from './helpers/health-api.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };

// Every page opened in a test, closed after it even when an assertion fails (an open page's timers would hang the run)
const pages = [];
afterEach(() => { while (pages.length) pages.pop().close(); });

// offline(): a predicate on (method, path) that makes fetch fail like a dead zone at the gym
async function open({ offline = () => false, storage } = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://health.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => memberToken(), autoLogin: () => false, login() {}, logout() {} };
      w.navigator.vibrate = () => true; w.scrollTo = () => {};
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const path = url.slice(API.length), method = o.method || 'GET';
        if (offline(method, path)) throw new TypeError('Failed to fetch');
        const r = await call(method, path, o.body ? JSON.parse(o.body) : undefined);
        return json(r.status, r.body);
      };
    },
  });
  pages.push(dom.window);
  await wait(80);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const all = (sel) => [...d.querySelectorAll(sel)];
  const click = async (sel) => { el(sel).click(); await wait(); };
  const type = async (sel, v) => { const e = el(sel); e.value = v; e.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const submit = async (sel) => { el(sel).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await wait(); };
  const button = (text) => all('button').find((b) => b.textContent.trim() === text) ?? assert.fail(`no button ${text}`);
  return { d, el, all, click, type, submit, button, w: dom.window, close: () => dom.window.close() };
}
const sessions = async () => (await call('GET', '/all')).body.sessions;

beforeEach(() => table.clear());

test('an empty account offers the starter program, and then the plan’s first workout', async () => {
  const p = await open();
  await p.click('[data-act="starter"]');
  await wait(50);
  assert.equal((await call('GET', '/all')).body.workouts.length, 3);
  assert.match(p.el('.next h2').textContent, /Session A/);
  assert.ok(p.button('Session B') && p.button('Mobility') && p.button('Empty session'));
  p.close();
});

test('log a session: sets save as you go, a tick starts the rest timer, finishing moves the plan on', async () => {
  await call('POST', '/starter');
  const p = await open();
  await p.click('.next [data-start]');
  assert.equal(p.el('.entry h3').textContent.includes('Trap bar deadlift'), true);
  assert.equal(p.el('.entry .tag').textContent, '1a');
  assert.match(p.el('.entry p.small:not(.muted)').textContent, /First time/);
  await p.type('[data-entry="0"] [data-set="0"][data-k="w"]', '135');
  await p.type('[data-entry="0"] [data-set="0"][data-k="r"]', '8');
  await p.click('[data-entry="0"] [data-tick="0"]');
  assert.equal(p.el('#timer').hidden, false);
  assert.match(p.el('#timer .clock').textContent, /0:1[45]/, 'the 15 s walk to the pair’s second exercise');
  await wait(700);
  let [s] = await sessions();
  assert.deepEqual(s.entries[0].sets[0], { w: 135, r: 8, t: null, d: null, b: null, done: true });
  assert.equal(s.finishedAt, null);

  await p.click('[data-area="Shoulders"][data-v="3"]');
  await p.click('[data-act="finish"]');
  await wait(50);
  [s] = await sessions();
  assert.ok(s.finishedAt);
  assert.deepEqual(s.discomfort, { Shoulders: 3 });
  assert.equal(p.el('#timer').hidden, true);
  assert.match(p.el('.next h2').textContent, /Session B/, 'A done, so B is next');
  assert.match(p.el('.week .done .dot').textContent, /✓/);
  p.close();
});

test('a new session starts from last time’s numbers, and says what they were', async () => {
  const { body } = await call('POST', '/starter');
  const a = body.workouts.find((w) => w.name === 'Session A'), tb = a.items[0].exerciseId;
  await call('PUT', '/sessions/old', {
    date: daysAgo(2), workoutId: a.id, name: 'Session A', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    entries: [{ exerciseId: tb, name: 'Trap bar deadlift', measure: 'reps', sets: [{ w: 135, r: 8, done: true }, { w: 145, r: 6, done: true }, { w: 200, r: 1, done: false }] }],
  });
  const p = await open();
  await p.click('[data-start="' + a.id + '"]');
  assert.match(p.el('[data-entry="0"] p.small:not(.muted)').textContent, /Last time .*: 135 × 8, 145 × 6$/);
  const w = p.all('[data-entry="0"] [data-k="w"]').map((i) => i.value), r = p.all('[data-entry="0"] [data-k="r"]').map((i) => i.value);
  assert.deepEqual(w, ['135', '145', '145'], 'the third set repeats the last one done; the undone 200 is ignored');
  assert.deepEqual(r, ['8', '6', '6']);
  assert.ok(p.all('[data-entry="0"] .set').every((s) => !s.classList.contains('done')));
  p.close();
});

test('no signal at the gym: the session is kept on the phone and saved on the next load', async () => {
  await call('POST', '/starter');
  const p = await open({ offline: (m) => m === 'PUT' });
  await p.click('.next [data-start]');
  await p.type('[data-entry="0"] [data-set="0"][data-k="w"]', '155');
  await wait(700);
  assert.match(p.el('#status').textContent, /Not saved yet/);
  assert.deepEqual(await sessions(), []);
  const draft = p.w.localStorage.getItem('health-draft');
  p.close();

  const q = await open({ storage: { 'health-draft': draft } });
  await wait(50);
  const [s] = await sessions();
  assert.equal(s.entries[0].sets[0].w, 155);
  assert.equal(q.el('[data-entry="0"] [data-set="0"][data-k="w"]').value, '155', 'and it’s open again on Today');
  assert.equal(q.w.localStorage.getItem('health-draft'), null);
  q.close();
});

test('a stale draft doesn’t overwrite a session saved since on another device', async () => {
  await call('PUT', '/sessions/s1', { date: daysAgo(0), name: 'A', entries: [] });
  await call('PUT', '/sessions/s1', { date: daysAgo(0), name: 'A, from the laptop', entries: [], rev: 1 });
  const p = await open({ storage: { 'health-draft': JSON.stringify({ id: 's1', rev: 1, date: daysAgo(0), name: 'A, phone', entries: [], discomfort: {}, note: '' }) } });
  await wait(50);
  assert.equal((await sessions())[0].name, 'A, from the laptop');
  p.close();
});

test('history opens a past session to fix it', async () => {
  await call('PUT', '/sessions/s1', { date: daysAgo(3), name: 'Session A', finishedAt: new Date().toISOString(),
    entries: [{ name: 'Push-up', measure: 'reps', sets: [{ r: 10, done: true }] }] });
  const p = await open();
  await p.click('[data-tab="history"]');
  assert.match(p.el('.list li').textContent, /Session A.*1 sets/s);
  await p.click('[data-open="s1"]');
  await p.type('[data-entry="0"] [data-set="0"][data-k="r"]', '12');
  await wait(700);
  assert.equal((await sessions())[0].entries[0].sets[0].r, 12);
  await p.click('[data-act="close"]');
  assert.equal(p.el('[data-tab="history"]').getAttribute('aria-pressed'), 'true');
  p.close();
});

test('a hold counts breaths, not seconds', async () => {
  const { body } = await call('POST', '/starter');
  const mob = body.workouts.find((w) => w.name === 'Mobility');
  const p = await open();
  await p.click('[data-start="' + mob.id + '"]');
  const i = p.all('.entry h3').findIndex((h) => /Couch stretch/.test(h.textContent));
  assert.match(p.all('.entry h3')[i].textContent, /12 breaths/, 'the target is in breaths too');
  assert.match(p.el(`[data-entry="${i}"] .units`).textContent, /Breaths/);
  await p.type(`[data-entry="${i}"] [data-set="0"][data-k="b"]`, '10');
  await p.click(`[data-entry="${i}"] [data-tick="0"]`);
  await p.click('[data-act="finish"]');
  await wait(50);
  assert.equal((await sessions())[0].entries[i].sets[0].b, 10);
  await p.click('[data-start="' + mob.id + '"]');
  assert.match(p.el(`[data-entry="${i}"] p.small:not(.muted)`).textContent, /Last time .*: 10 breaths$/);
  await p.click('[data-tab="exercises"]');
  assert.match(p.all('.list li').find((li) => /Couch stretch/.test(li.textContent)).textContent, /Breaths/);
  p.close();
});

test('the journal: today’s words save as you type, and past days are on Journal', async () => {
  await call('PUT', `/journal/${daysAgo(2)}`, { text: 'Hip tight.\n<b>not bold</b>' });
  const p = await open();
  await p.type(`textarea[data-jdate="${daysAgo(0)}"]`, 'Slept well, back fine.');
  await wait(900);
  let j = (await call('GET', '/all')).body.journal;
  assert.deepEqual(j.map((x) => x.text), ['Hip tight.\n<b>not bold</b>', 'Slept well, back fine.']);
  await p.type(`textarea[data-jdate="${daysAgo(0)}"]`, 'Slept well, back fine. Knee sore later.');
  await wait(900);
  assert.equal((await call('GET', '/all')).body.journal[1].text, 'Slept well, back fine. Knee sore later.', 'a second save carries the new rev');

  await p.click('[data-tab="journal"]');
  assert.equal(p.el('textarea.journal').value, 'Slept well, back fine. Knee sore later.');
  assert.equal(p.all('#main b').length, 0, 'shown as text');
  await p.click(`[data-jday="${daysAgo(2)}"]`);
  assert.equal(p.el('textarea.journal').value, 'Hip tight.\n<b>not bold</b>');
  // Typing in one day and switching straight to another still saves the first
  await p.type(`textarea[data-jdate="${daysAgo(2)}"]`, 'Hip tight, eased by evening.');
  await p.click(`[data-jday="${daysAgo(0)}"]`);
  await p.type(`textarea[data-jdate="${daysAgo(0)}"]`, 'Today again.');
  await wait(900);
  j = (await call('GET', '/all')).body.journal;
  assert.deepEqual(j.map((x) => x.text), ['Hip tight, eased by evening.', 'Today again.']);
  p.close();
});

test('food: a quick add on Today, and the Food tab to fix or delete', async () => {
  await call('PUT', '/food/d1', { date: daysAgo(0), time: '07:30', meal: 'breakfast', what: 'Eggs and toast', kcal: 420, protein: 24 });
  await call('PUT', '/food/old', { date: daysAgo(1), time: '19:00', what: '<b>Tacos</b>', kcal: 800 });
  table.put({ ...table.get('P#luke-sub', 'F#d1'), source: 'dot' });
  const p = await open();
  assert.match(p.el('.food').textContent, /Eggs and toast.*420 kcal · 24 g protein \(Dot’s estimate\)/s);
  await p.type('#food-quick [name="what"]', 'Apple');
  await p.submit('#food-quick');
  let food = (await call('GET', '/all')).body.food.filter((f) => f.date === daysAgo(0));
  assert.deepEqual(food.map((f) => f.what).sort(), ['Apple', 'Eggs and toast']);
  const apple = food.find((f) => f.what === 'Apple');
  assert.match(apple.time, /^\d\d:\d\d$/);
  assert.ok(['breakfast', 'lunch', 'dinner', 'snack'].includes(apple.meal), 'a meal guessed from the clock');

  await p.click('[data-editfood="d1"]');
  assert.equal(p.el('[data-tab="food"]').getAttribute('aria-pressed'), 'true');
  assert.equal(p.el('#food-form [name="what"]').value, 'Eggs and toast');
  p.el('#food-form [name="kcal"]').value = '380';
  await p.submit('#food-form');
  assert.equal((await call('GET', '/all')).body.food.find((f) => f.id === 'd1').kcal, 380);
  assert.match(p.el('#main').textContent, /About 380 kcal · 24 g protein/);

  await p.click(`[data-fday="${daysAgo(1)}"]`);
  assert.equal(p.all('#main b').length, 0, 'shown as text');
  await p.click('[data-editfood="old"]');
  await p.click('[data-act="delfood"]');
  await p.click('[data-act="delfood"]');
  await wait(50);
  assert.deepEqual((await call('GET', '/all')).body.food.map((f) => f.id).includes('old'), false);
  p.close();
});

test('meds: add one on the Meds tab, then tick it off on Today', async () => {
  const p = await open();
  assert.equal(p.all('.meds').length, 0, 'no meds, no card');
  await p.click('[data-tab="meds"]');
  p.el('#med-form [name="name"]').value = 'Vitamin D';
  p.el('#med-form [name="dose"]').value = '2000 IU';
  p.el('#med-form [name="times"]').value = '20:00, 8:00';
  await p.submit('#med-form');
  const [m] = (await call('GET', '/all')).body.meds;
  assert.deepEqual([m.name, m.times], ['Vitamin D', ['08:00', '20:00']]);
  p.el('#med-form [name="name"]').value = 'Bad';
  p.el('#med-form [name="times"]').value = '8am';
  await p.submit('#med-form');
  assert.match(p.el('#status').textContent, /Times are like 08:00/);
  assert.equal((await call('GET', '/all')).body.meds.length, 1);

  await p.click('[data-tab="today"]');
  assert.deepEqual(p.all('.meds .when').map((x) => x.textContent), ['08:00', '20:00']);
  await p.click(`[data-dose="${m.id}"][data-slot="08:00"]`);
  await wait(30);
  const doses = (await call('GET', '/all')).body.doses;
  assert.deepEqual(doses.map((d) => [d.date, d.slot]), [[daysAgo(0), '08:00']]);
  assert.match(doses[0].at, /^\d\d:\d\d$/);
  assert.equal(p.el(`[data-dose="${m.id}"][data-slot="08:00"]`).getAttribute('aria-pressed'), 'true');
  assert.match(p.el('.meds').textContent, /Taken \d\d:\d\d/);
  await p.click(`[data-dose="${m.id}"][data-slot="08:00"]`);
  await wait(30);
  assert.deepEqual((await call('GET', '/all')).body.doses, [], 'ticking again undoes it');
  p.close();
});

test('meds: as needed, logged each time; stopped ones drop off the checklist but keep their history', async () => {
  await call('PUT', '/meds/ibu', { name: 'Ibuprofen', kind: 'medication', dose: '200 mg' });
  await call('PUT', '/meds/old', { name: 'Old pill', times: ['09:00'] });
  await call('PUT', `/doses/${daysAgo(1)}/old-0900`, { med: 'old', slot: '09:00', at: '09:10' });
  const p = await open();
  // Medications and supplements apart, each under its own heading
  assert.deepEqual(p.all('h3.kind').map((h) => h.textContent), ['Medications', 'Supplements']);
  assert.equal(p.el('h3.kind').nextElementSibling.querySelector('[data-prn="ibu"]') !== null, true, 'ibuprofen under Medications');
  assert.equal(p.all('h3.kind')[1].nextElementSibling.querySelector('[data-dose="old"]') !== null, true, 'the supplement under Supplements');
  await p.click('[data-prn="ibu"]');
  await wait(30);
  await p.click('[data-prn="ibu"]');
  await wait(30);
  assert.equal((await call('GET', '/all')).body.doses.filter((d) => d.med === 'ibu').length, 2);
  await p.click('[data-undose]');
  await wait(30);
  assert.equal((await call('GET', '/all')).body.doses.filter((d) => d.med === 'ibu').length, 1);

  await p.click('[data-tab="meds"]');
  assert.equal(p.all('h3.kind')[3].nextElementSibling.querySelector('[data-editmed="old"]') !== null, true, 'the list is apart too');
  await p.click('[data-editmed="old"]');
  p.el('#med-form [name="stopped"]').checked = true;
  await p.submit('#med-form');
  assert.equal(p.d.querySelector('[data-dose="old"]'), null, 'off the checklist');
  assert.match(p.el('[data-editmed="old"]').textContent, /stopped/);
  assert.equal((await call('GET', '/all')).body.doses.filter((d) => d.med === 'old').length, 1, 'history kept');
  p.close();
});

test('meditate: the timer runs, pauses, ends with a note to save; the Today card shows the week', async () => {
  const p = await open();
  assert.equal(p.d.querySelector('[data-tab="meditate"]').textContent, 'Meditate');
  await p.click('[data-tab="meditate"]');
  p.el('#sit-start [name="min"][value="5"]').checked = true;
  await p.submit('#sit-start');
  let run = JSON.parse(p.w.localStorage.getItem('health-sit-run'));
  assert.equal(run.total, 300000);
  assert.match(p.el('.sit-clock').textContent, /^[45]:\d\d$/);
  await p.click('[data-act="sitpause"]');
  assert.match(p.el('.sit').textContent, /Paused/);
  await p.click('[data-act="sitresume"]');
  // Nearly over: the tick ends it, and asks how it went
  run = JSON.parse(p.w.localStorage.getItem('health-sit-run'));
  run.end = Date.now() + 200;
  p.w.localStorage.setItem('health-sit-run', JSON.stringify(run));
  await wait(700);
  assert.ok(p.el('#sit-after'), 'the note after');
  assert.match(p.el('#sit-after h2').textContent, /5 min sat/);
  p.el('#sit-after [name="note"]').value = 'Breath, then the birds.';
  await p.submit('#sit-after');
  const [sit] = (await call('GET', '/all')).body.sits;
  assert.deepEqual([sit.date, sit.seconds, sit.note], [daysAgo(0), 300, 'Breath, then the birds.']);
  assert.equal(p.w.localStorage.getItem('health-sit-run'), null);
  assert.ok(p.el('#sit-start'), 'ready for the next one');
  assert.equal(JSON.parse(p.w.localStorage.getItem('health-sit')).min, 5, 'remembers the length');
  await p.click('[data-tab="today"]');
  assert.match(p.d.body.textContent, /5 min today · 5 min this week/);
});

test('meditate: ended while away is logged at full length; End now logs what was sat; a sit logged and fixed by hand', async () => {
  const away = { date: daysAgo(0), time: '06:30', total: 600000, end: Date.now() - 60000, left: null, bell: 0, rung: 0 };
  let p = await open({ storage: { 'health-sit-run': JSON.stringify(away) } });
  await p.click('[data-tab="meditate"]');
  await wait(400);
  assert.match(p.el('#sit-after h2').textContent, /10 min sat/);
  await p.click('[data-act="sitdiscard"]');
  assert.deepEqual((await call('GET', '/all')).body.sits, [], 'not logged unless saved');
  p.close();

  const half = { date: daysAgo(0), time: '06:30', total: 600000, end: Date.now() + 350000, left: null, bell: 0, rung: 0 };
  p = await open({ storage: { 'health-sit-run': JSON.stringify(half) } });
  await p.click('[data-tab="meditate"]');
  await p.click('[data-act="sitend"]');
  assert.match(p.el('#sit-after h2').textContent, /4 min sat/);
  await p.submit('#sit-after');
  const [s] = (await call('GET', '/all')).body.sits;
  assert.ok(s.seconds >= 249 && s.seconds <= 251, String(s.seconds));

  await p.click('[data-act="sitnew"]');
  p.el('#sit-form [name="date"]').value = daysAgo(1);
  p.el('#sit-form [name="minutes"]').value = '20';
  p.el('#sit-form [name="note"]').value = 'Evening sit.';
  await p.submit('#sit-form');
  await p.click(`[data-editsit="${s.id}"]`);
  p.el('#sit-form [name="note"]').value = 'Cut short.';
  await p.submit('#sit-form');
  const sits = (await call('GET', '/all')).body.sits;
  assert.deepEqual(sits.map((x) => [x.date, x.note]), [[daysAgo(1), 'Evening sit.'], [daysAgo(0), 'Cut short.']]);
  assert.equal(sits[1].seconds, s.seconds, 'unchanged minutes keep the timer’s seconds');
  assert.equal(sits[0].seconds, 1200);
  assert.match(p.d.body.textContent, /2 days in a row/);
  p.close();
});

test('the plan: pick days and order the rotation', async () => {
  await call('POST', '/starter');
  const p = await open();
  await p.click('[data-tab="plan"]');
  assert.deepEqual(p.all('#rot li .grow').map((x) => x.textContent), ['1. Session A', '2. Session B']);
  p.el('[name="day"][value="2"]').checked = true;
  await p.click('[data-rotup="1"]');
  assert.equal(p.el('[name="day"][value="2"]').checked, true, 'a ticked day survives reordering');
  await p.submit('#plan-form');
  const plan = (await call('GET', '/all')).body.plan;
  assert.deepEqual(plan.days, [1, 2, 3, 5]);
  const names = (await call('GET', '/all')).body.workouts;
  assert.deepEqual(plan.rotation.map((id) => names.find((w) => w.id === id).name), ['Session B', 'Session A']);
  p.close();
});

test('build a workout from your exercises', async () => {
  await call('PUT', '/exercises/sq', { name: 'Squat' });
  const p = await open();
  await p.click('[data-tab="workouts"]');
  await p.click('[data-act="newworkout"]');
  p.el('#wo-form [name="name"]').value = 'Legs';
  await p.click('[data-act="additem"]');
  assert.equal(p.el('#wo-form [name="name"]').value, 'Legs', 'what’s typed survives adding an item');
  p.el('[data-item="0"] [data-ik="sets"]').value = '4';
  await p.submit('#wo-form');
  const [w] = (await call('GET', '/all')).body.workouts;
  assert.deepEqual([w.name, w.items[0].exerciseId, w.items[0].sets], ['Legs', 'sq', 4]);
  p.close();
});

test('deleting an exercise a workout uses says which workout', async () => {
  await call('PUT', '/exercises/sq', { name: 'Squat' });
  await call('PUT', '/workouts/w1', { name: 'Legs', items: [{ exerciseId: 'sq' }] });
  const p = await open();
  await p.click('[data-tab="exercises"]');
  await p.click('[data-editex="sq"]');
  await p.click('[data-act="delexercise"]');
  await p.click('[data-act="delexercise"]');
  assert.match(p.el('#status').textContent, /It’s in Legs/);
  p.close();
});

test('names are shown as text, never as HTML', async () => {
  await call('PUT', '/exercises/x', { name: '<img src=x onerror=alert(1)>' });
  await call('PUT', '/workouts/w1', { name: '<b>bold</b>', items: [{ exerciseId: 'x' }] });
  const p = await open();
  assert.equal(p.all('main img, #main img, #main b').length, 0);
  await p.click('[data-start="w1"]');
  assert.equal(p.all('#main img').length, 0);
  assert.match(p.el('.entry h3').textContent, /<img/);
  p.close();
});
