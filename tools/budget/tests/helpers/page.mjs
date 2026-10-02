// Opens the real budget page in jsdom. Its API calls go to the real Lambda handler
// (helpers/budget-api.mjs) backed by the fake table, so page -> API -> table is all real code.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { call, memberToken } from './budget-api.mjs';

const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
  .replace('<script src="family-auth.js"></script>', '');
const API = 'https://api.test';
export const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let inFlight = 0;
/** Edits save ~0.9s after the last change: wait for that, then for every request to finish */
export async function saved() {
  await wait(1000);
  for (let i = 0; inFlight > 0 && i < 200; i++) await wait(10);
  await wait(10);
}

export async function openBudget(hash = '#shared') {
  const requests = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: `https://budget.dot-y.co/${hash}`, pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.FamilyAuth = { init: async () => ({ email: 'test' }), accessToken: async () => memberToken(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const method = o.method || 'GET', path = url.slice(API.length);
        requests.push(`${method} ${path}`);
        inFlight++;
        try {
          const r = await call(method, path, o.body ? JSON.parse(o.body) : undefined);
          return json(r.status, r.body);
        } finally {
          inFlight--;
        }
      };
    },
  });
  const w = dom.window, d = w.document;
  await wait(50);
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  return {
    w, d, requests,
    el,
    text: (id) => d.getElementById(id)?.textContent,
    click: (sel) => el(sel).click(),
    /** Sets a field's value and fires the event the page listens for */
    type: (target, value, event = 'input') => {
      const e = typeof target === 'string' ? el(target) : target;
      e.value = value; e.dispatchEvent(new w.Event(event, { bubbles: true }));
    },
    tab: async (t) => { el(`[data-tab="${t}"]`).click(); await wait(); },
    names: () => [...d.querySelectorAll('.cat-name')].map((i) => i.value),
    close: () => w.close(),
  };
}
