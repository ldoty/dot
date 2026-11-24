import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { ROUTES } from './helpers/routes.mjs';
import { drill } from './helpers/drills.mjs';

const table = fakeTable();
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-go', group: 'lukes_go', issuer: ISSUER,
  clientIds: ['go-client'], now: () => new Date(), timeZone: 'America/New_York',
});
const call = caller(handler, ROUTES);
const token = () => accessToken({ clientId: 'go-client', group: 'lukes_go', sub: 'luke', username: 'luke' });

// The page with its two scripts inlined: the shared rules, then the page's own (family-auth is stubbed)
const RULES = readFileSync(new URL('../web/rules.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  .replace('<script src="family-auth.js"></script>', '')
  .replace('<script src="rules.js"></script>', () => `<script>${RULES}</script>`);
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

async function open() {
  const posted = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://go.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.confirm = () => true;
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const body = o.body ? JSON.parse(o.body) : undefined;
        if ((o.method || 'GET') === 'POST') posted.push([url.slice(API.length), body]);
        const r = await call(o.method || 'GET', url.slice(API.length), body, token());
        return json(r.status, r.body);
      };
    },
  });
  await wait(100);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const click = async (sel) => { el(sel).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await wait(); };
  return { d, el, click, posted, text: () => d.body.textContent, close: () => dom.window.close() };
}

beforeEach(() => table.clear());

test('home shows the error database, biggest cost first, and a drill per kind', async () => {
  table.put({ pk: 'PROFILE', sk: 'mistakes', games: 20, moves: 500, byKind: { ignored_threat: { n: 10, points: 60 }, endgame: { n: 30, points: 90 }, missed_kill: { n: 0, points: 0 } }, at: '2026-11-24T12:00:00Z' });
  table.put(drill('fix', { theme: 'endgame', mine: true }));
  table.put(drill('threat'));
  const p = await open();
  const kinds = [...p.d.querySelectorAll('li strong')].map((s) => s.textContent);
  assert.deepEqual(kinds.slice(0, 2), ['Endgame order', 'Ignored a threat']);
  assert.ok(!kinds.includes('Missed a kill'), 'kinds he never made are left out');
  assert.match(p.text(), /last 20 9x9 games/);
  assert.ok(p.d.querySelector('[data-study="threat"]'));
  assert.ok(p.d.querySelector('[data-study="fix"][data-theme="endgame"]'));
  p.close();
});

test('fix a move: a right click is graded Good or Easy and the review is sent', async () => {
  const f = drill('fix', { theme: 'key_point', answers: [49, 50], played: 2, loss: 5.5, mine: true });
  table.put(f);
  table.put({ pk: 'PROFILE', sk: 'mistakes', games: 1, moves: 30, byKind: { key_point: { n: 1, points: 5.5 } }, at: 'x' });
  const p = await open();
  await p.click('[data-study="fix"][data-theme="key_point"]');
  assert.match(p.text(), /In your game, Black played a move here that lost 5.5 points/);
  await p.click('[data-pt="49"]');
  assert.match(p.text(), /Right: E4/);
  assert.match(p.text(), /The game move, C9, lost 5.5/);
  assert.deepEqual([...p.d.querySelectorAll('.legend span')].map((x) => x.textContent), ['KataGo’s best', 'The game move', 'The last move']);
  assert.match(p.el('.grades .pick').dataset.grade, /good|easy/);
  await p.click('.grades .pick');
  assert.equal(p.posted.length, 1);
  assert.equal(p.posted[0][0], `/drills/fix/${f.sk}/review`);
  assert.match(p.text(), /1 of 1 right the first time/);
  p.close();
});

test('a wrong answer suggests Again, and the drill comes back before the session ends', async () => {
  table.put(drill('threat', { answers: [30], cost: 9.2 }));
  const p = await open();
  await p.click('[data-study="threat"]');
  await p.click('[data-pt="0"]');
  assert.match(p.text(), /Not A9/);
  assert.deepEqual([...p.d.querySelectorAll('.legend span')].map((x) => x.textContent), ['The threat', 'Your move', 'The last move']);
  assert.match(p.text(), /The threat: D6\. Ignoring it costs about 9 points/);
  assert.equal(p.el('.grades .pick').dataset.grade, 'again');
  await p.click('.grades .pick');
  // The same drill again: this time right
  await p.click('[data-pt="30"]');
  assert.match(p.text(), /That’s it: D6/);
  await p.click('.grades .pick');
  assert.match(p.text(), /0 of 1 right the first time/);
  assert.equal(p.posted.length, 2);
  p.close();
});

test('who’s ahead: the guess is checked against KataGo’s score, with the error sent', async () => {
  table.put(drill('count', { lead: -3.5 }));
  const p = await open();
  await p.click('[data-study="count"]');
  assert.match(p.text(), /Komi 6.5/);
  await p.click('[data-side="w"]');
  p.el('#margin').value = '5';
  p.el('#guess').dispatchEvent(new p.d.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  assert.match(p.text(), /KataGo: White by 3.5\. You said White by 5: off by 1.5/);
  assert.equal(p.el('.grades .pick').dataset.grade, 'good');
  await p.click('.grades .pick');
  assert.equal(p.posted[0][1].err, 1.5);
  p.close();
});

test('who’s ahead: the wrong side, or far off, is Again', async () => {
  table.put(drill('count', { lead: 4 }));
  const p = await open();
  await p.click('[data-study="count"]');
  await p.click('[data-side="w"]');
  p.el('#margin').value = '1';
  p.el('#guess').dispatchEvent(new p.d.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  assert.match(p.text(), /KataGo: Black by 4\. You said White by 1: off by 5/);
  assert.equal(p.el('.grades .pick').dataset.grade, 'again');
  p.close();
});

test('life and death: follow the tree; the opponent answers; a move it doesn’t list is wrong', async () => {
  // Black plays C1 (x 2, y 8); White answers B1; then Black A2 is correct
  const tree = { x: -1, y: -1, branches: [{ x: 2, y: 8, branches: [{ x: 1, y: 8, branches: [{ x: 0, y: 7, correct_answer: true }] }] }] };
  table.put(drill('tsumego', { stones: '0'.repeat(81), tree: JSON.stringify(tree), last: -1 }));
  let p = await open();
  await p.click('[data-study="tsumego"]');
  await p.click('[data-pt="74"]');
  assert.ok(!p.d.querySelector('.grades'), 'not over yet');
  assert.ok(p.d.querySelectorAll('circle[r="18"]').length === 2, 'both stones on the board');
  await p.click('[data-pt="63"]');
  assert.match(p.text(), /Solved/);
  p.close();
  table.clear();
  table.put(drill('tsumego', { stones: '0'.repeat(81), tree, last: -1 }));
  p = await open();
  await p.click('[data-study="tsumego"]');
  await p.click('[data-pt="40"]');
  assert.match(p.text(), /That doesn’t work\.The answer: C1, B1, A2/);
  p.close();
});

test('picking the game’s own move shows it as the played move', async () => {
  table.put(drill('fix', { answers: [49], played: 2 }));
  const p = await open();
  await p.click('[data-study="fix"]');
  await p.click('[data-pt="2"]');
  assert.ok(p.d.querySelector('path[stroke="var(--ember)"]'), 'the red cross on the played move');
  assert.ok(!p.d.querySelector('circle[fill="var(--pool)"]'), 'not a plain pick dot');
  p.close();
});

test('after answering: step through KataGo’s line, leave it with your own move, go back', async () => {
  // Black to play; KataGo's line E4 (49), D4 (48), F5 (41); after the game move C9 (2), White E4 (49)
  table.put(drill('fix', { answers: [49], played: 2, lines: { best: [49, 48, 41], game: [2, 49] } }));
  const p = await open();
  await p.click('[data-study="fix"]');
  await p.click('[data-pt="49"]');
  await p.click('[data-line="best"]');
  assert.match(p.el('#exinfo').textContent, /Move 1: Black E4 \(KataGo’s line, 1 of 3\)/);
  await p.click('[data-step="fwd"]');
  assert.match(p.el('#exinfo').textContent, /Move 2: White D4/);
  const nums = () => [...p.d.querySelectorAll('svg text')].map((t) => t.textContent).filter((t) => /^\d+$/.test(t) && Number(t) < 10 && t.length === 1);
  assert.ok(nums().includes('2'), 'move numbers on the stones');
  await p.click('[data-step="end"]');
  assert.match(p.el('#exinfo').textContent, /Move 3: Black F5.*3 of 3/);
  // Back one, then Black plays somewhere else: off the line
  await p.click('[data-step="back"]');
  await p.click('[data-pt="80"]');
  assert.match(p.el('#exinfo').textContent, /Move 3: Black J1\. Your own moves since move 3/);
  await p.click('[data-pt="79"]');
  assert.match(p.el('#exinfo').textContent, /Move 4: White H1/);
  // The game's line instead, and back to the start
  await p.click('[data-line="game"]');
  assert.match(p.el('#exinfo').textContent, /Move 1: Black C9/);
  await p.click('[data-step="start"]');
  assert.match(p.el('#exinfo').textContent, /Step through a line/);
  // Still graded as before
  assert.ok(p.d.querySelector('.grades .pick'));
  p.close();
});

test('a threat’s “ignore it” line starts with playing elsewhere; life and death shows its answer', async () => {
  table.put(drill('threat', { answers: [30], lines: { answer: [22, 30], ignore: [-1, 30, 21] } }));
  let p = await open();
  await p.click('[data-study="threat"]');
  await p.click('[data-pt="30"]');
  await p.click('[data-line="ignore"]');
  assert.match(p.el('#exinfo').textContent, /Move 1: Black plays elsewhere/);
  await p.click('[data-step="fwd"]');
  assert.match(p.el('#exinfo').textContent, /Move 2: White D6/);
  p.close();
  table.clear();
  const tree = { x: -1, y: -1, branches: [{ x: 2, y: 8, branches: [{ x: 1, y: 8, branches: [{ x: 0, y: 7, correct_answer: true }] }] }] };
  table.put(drill('tsumego', { stones: '0'.repeat(81), tree: JSON.stringify(tree), last: -1 }));
  p = await open();
  await p.click('[data-study="tsumego"]');
  await p.click('[data-pt="40"]');
  await p.click('[data-line="answer"]');
  await p.click('[data-step="end"]');
  assert.match(p.el('#exinfo').textContent, /Move 3: Black A2 \(The answer, 3 of 3\)/);
  p.close();
});

test('the program: start it, see the focus and its rule, do today’s session in order, see real games by week', async () => {
  table.put({ pk: 'PROFILE', sk: 'mistakes', games: 20, moves: 500, byKind: { lost_stones: { n: 20, points: 380 }, wrong_area: { n: 24, points: 180 } }, at: 'x' });
  table.put({ pk: 'WEEK', sk: '2026-11-09', games: 10, moves: 250, byKind: { lost_stones: { n: 10, points: 200 } } });
  table.put({ pk: 'WEEK', sk: '2026-11-16', games: 10, moves: 250, byKind: { lost_stones: { n: 8, points: 150 }, wrong_area: { n: 5, points: 40 } } });
  table.put(drill('tsumego', { rank: 5, stones: '0'.repeat(81), tree: JSON.stringify({ x: -1, y: -1, branches: [{ x: 0, y: 0, correct_answer: true }] }) }));
  table.put(drill('fix', { theme: 'lost_stones', answers: [49], mine: true }));
  table.put(drill('count', { lead: 2 }));
  const p = await open();
  assert.match(p.text(), /First: Let stones die\. Then played in the wrong area\./);
  await p.click('[data-plan="start"]');
  await wait(60);
  assert.match(p.text(), /Focus 1 of 2: Let stones die/);
  assert.match(p.el('.train .rule').textContent, /weakest group/);
  assert.match(p.el('[data-today]').textContent, /3 left/);
  // Two charts (the focus and everything), and the table under them
  assert.deepEqual([...p.d.querySelectorAll('.chart h3')].map((h) => h.textContent), ['Let stones die: points a game', 'All mistakes: points a game']);
  assert.match(p.d.querySelector('.chart title').textContent, /Week of 2026-11-09: 20.0 points a game \(10 games\)/);
  assert.deepEqual([...p.d.querySelectorAll('table.weeks td')].slice(0, 4).map((x) => x.textContent), ['2026-11-09', '10', '20.0', '20.0']);
  // Today: the warm-up first, then the focus, then counting
  await p.click('[data-today]');
  assert.match(p.el('.chip.due').textContent, /Warm-up/);
  await p.click('[data-pt="0"]');
  await p.click('.grades .pick');
  assert.match(p.el('.chip.due').textContent, /Focus/);
  await p.click('[data-pt="49"]');
  await p.click('.grades .pick');
  assert.match(p.el('.chip.due').textContent, /Counting/);
  await p.click('[data-side="b"]');
  p.el('#margin').value = '2';
  p.el('#guess').dispatchEvent(new p.d.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  await p.click('.grades .pick');
  assert.match(p.text(), /That’s today’s training/);
  await p.click('[data-home]');
  await wait(60);
  assert.match(p.text(), /Today’s training is done/);
  assert.match(p.text(), /1 focus drill, 100% right/);
  // Skipping ahead (not ready yet) asks first, then moves on
  await p.click('[data-plan="next"]');
  await wait(60);
  assert.match(p.text(), /Focus 2 of 2: Played in the wrong area/);
  p.close();
});
