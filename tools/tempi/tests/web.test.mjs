// The course page in jsdom: signs in, loads the course and progress from the API, saves changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const COURSE = readFileSync(new URL('../api/course.html', import.meta.url), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ server = null, local = null, status = 200 } = {}) {
  const puts = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://tempi.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      if (local) w.localStorage.setItem('tempi-ot-course-v1', JSON.stringify(local));
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => 'tok', autoLogin: () => false, login() {}, logout() {} };
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

test('the public shell has no course content', () => {
  assert.doesNotMatch(HTML, /Tempi|Doty/);
});

test('loads the course and starts from your saved progress', async () => {
  const { d, dom } = await open({ server: { done: { m1: true, m2: true }, j: {}, s: {}, last: 'm2' } });
  assert.match(d.body.textContent, /Pediatric Occupational Therapy/);
  assert.equal(d.getElementById('doneCount').textContent, '2 of 6 modules');
  assert.equal(d.getElementById('p-m2').hidden, false, 'reopens the last module');
  dom.window.close();
});

test('saves changes to your account', async () => {
  const { d, w, puts, dom } = await open();
  d.querySelector('.done-btn[data-mod="m1"]').click();
  const t = d.querySelector('textarea[data-j]');
  t.value = 'I liked the putty'; t.dispatchEvent(new w.Event('input'));
  await wait(1700);
  const last = puts.at(-1).progress;
  assert.equal(last.done.m1, true);
  assert.equal(last.j[t.dataset.j], 'I liked the putty');
  assert.equal(JSON.parse(w.localStorage.getItem('tempi-ot-course-v1')).done.m1, true);
  dom.window.close();
});

test('uploads progress this browser had before the account had any', async () => {
  const { puts, dom } = await open({ local: { done: { m3: true }, j: {}, s: {} } });
  await wait(1200);
  assert.equal(puts[0].progress.done.m3, true);
  dom.window.close();
});

test('tells non-members they lack access', async () => {
  const { d, dom } = await open({ status: 403 });
  assert.match(d.getElementById('gate-msg').textContent, /doesn’t have access/);
  dom.window.close();
});
