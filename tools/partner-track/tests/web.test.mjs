// The course page in jsdom: signs in, loads the course and progress from the API, saves changes,
// and runs the fund model, buyout model and prediction log on the real course markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const COURSE = readFileSync(new URL('../api/course.html', import.meta.url), 'utf8');
const KEY = 'partner-track-v1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ server = null, local = null, status = 200 } = {}) {
  const puts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://partner-track.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      if (local) w.localStorage.setItem(KEY, JSON.stringify(local));
      w.FamilyAuth = { init: async () => ({ email: 'l' }), accessToken: async () => 'tok', autoLogin: () => false, login() {}, logout() {} };
      w.scrollTo = () => {};
      w.fetch = async (url, o = {}) => {
        const res = (s, body) => ({ ok: s < 300, status: s, json: async () => JSON.parse(JSON.stringify(body)) });
        if (url === 'config.json') return res(200, { apiUrl: 'https://api.test' });
        if (url.endsWith('/course')) return res(status, status === 200 ? { html: COURSE } : {});
        if (url.endsWith('/progress') && (o.method || 'GET') === 'GET') return server ? res(200, { progress: server }) : res(404, {});
        if (url.endsWith('/progress')) { puts.push(JSON.parse(o.body)); return res(200, {}); }
        throw new Error('unexpected ' + url);
      };
    },
  });
  await wait(50);
  return { dom, d: dom.window.document, w: dom.window, puts };
}
const outRow = (d, box, label) => [...d.querySelectorAll(`#${box} .row`)].find((r) => r.querySelector('span').textContent.startsWith(label)).querySelector('b').textContent;

test('the public shell has no course content', () => {
  assert.doesNotMatch(HTML, /Doty|Luke|Contribution|brother|Horsley/);
});

test('loads the course and starts from your saved progress', async () => {
  const { d, dom } = await open({ server: { done: { m1: true, m2: true }, j: { m1a: 'One partner' }, last: 'm2' } });
  assert.match(d.body.textContent, /How a fund works/);
  assert.equal(d.getElementById('doneCount').textContent, '2 of 7');
  assert.equal(d.querySelectorAll('#bar i.on').length, 2);
  assert.equal(d.getElementById('p-m2').hidden, false, 'reopens the last page');
  assert.equal(d.getElementById('j-m1a').value, 'One partner');
  dom.window.close();
});

test('the fund model turns gross into net', async () => {
  const { d, w, dom } = await open();
  assert.equal(outRow(d, 'fundOut', 'Net multiple to LPs'), '2.06×', '$25M, 2/1.5% fees, $1.2M expenses, 20% carry, 3× gross');
  assert.equal(outRow(d, 'fundOut', 'Annual fee'), '$500K');
  const g = d.getElementById('f-gross'); g.value = '1'; g.dispatchEvent(new w.Event('input'));
  assert.equal(outRow(d, 'fundOut', 'Your carry'), '$0K', 'no carry when LPs don’t get their money back');
  dom.window.close();
});

test('the buyout model shows what the pool costs and pays', async () => {
  const { d, w, dom } = await open();
  assert.equal(outRow(d, 'lboOut', 'Investors without a pool'), '3.03× · 24.8% IRR');
  assert.equal(outRow(d, 'lboOut', 'Investors with the pool'), '2.72× · 22.2% IRR');
  const p = d.getElementById('l-pool'); p.value = '0'; p.dispatchEvent(new w.Event('input'));
  assert.equal(outRow(d, 'lboOut', 'Investors with the pool'), '3.03× · 24.8% IRR');
  dom.window.close();
});

test('saves changes to your account', async () => {
  const { d, w, puts, dom } = await open();
  d.querySelector('.done-btn[data-mod="m1"]').click();
  const t = d.getElementById('j-m4b');
  t.value = 'Small businesses will sell to their employees'; t.dispatchEvent(new w.Event('input'));
  d.querySelector('[data-quiz="m1"] .opt').click();
  d.getElementById('p-text').value = 'The template gets 10 adopters';
  d.getElementById('p-prob').value = '40';
  d.getElementById('pform').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await wait(1300);
  const last = puts.at(-1).progress;
  assert.equal(last.done.m1, true);
  assert.equal(last.j.m4b, 'Small businesses will sell to their employees');
  assert.equal(last.quiz['m1-0'], 0);
  assert.equal(last.preds[0].prob, 40);
  assert.equal(JSON.parse(w.localStorage.getItem(KEY)).done.m1, true);
  assert.equal(d.getElementById('sync').textContent, 'Saved to your account');
  dom.window.close();
});

test('scores resolved predictions', async () => {
  const preds = [
    { id: 'a', text: 'A', prob: 80, due: '2026-01-01', outcome: true },
    { id: 'b', text: 'B', prob: 60, due: '2026-01-01', outcome: false },
    { id: 'c', text: 'C', prob: 50, due: '2099-01-01', outcome: null },
  ];
  const { d, dom } = await open({ server: { preds } });
  assert.equal(d.getElementById('sbBrier').textContent, '0.200', '((0.2)² + (0.6)²) ÷ 2');
  assert.equal(d.getElementById('sbPred').textContent, '3');
  dom.window.close();
});

test('uploads progress this browser had before the account had any', async () => {
  const { puts, dom } = await open({ local: { done: { m3: true } } });
  await wait(1200);
  assert.equal(puts[0].progress.done.m3, true);
  dom.window.close();
});

test('tells non-members they lack access', async () => {
  const { d, dom } = await open({ status: 403 });
  assert.match(d.getElementById('gate-msg').textContent, /doesn’t have access/);
  dom.window.close();
});
