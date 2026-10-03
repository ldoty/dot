import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://fn.test';

/** Opens the page against canned API responses; /chat replies stream the given events in chunks */
async function open({ conversations = [], transcripts = {}, chat = [], hash = '' } = {}) {
  const requests = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: `https://assistant.dot-y.co/${hash}`, pretendToBeVisual: true,
    beforeParse(w) {
      w.TextDecoder = TextDecoder; // every browser has it; jsdom doesn't
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => 'tok', autoLogin: () => false, login() {}, logout() {} };
      w.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
      w.fetch = async (url, o = {}) => {
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        if (url === 'config.json') return json({ apiUrl: API });
        const method = o.method || 'GET', path = url.slice(API.length);
        requests.push({ method, path, body: o.body && JSON.parse(o.body), auth: o.headers?.authorization });
        if (path === '/conversations') return json(conversations);
        if (path.startsWith('/conversations/')) return json(transcripts[path.split('/')[2]]);
        if (path === '/chat') {
          const text = chat.map((e) => JSON.stringify(e) + '\n').join('');
          const parts = text.match(/[\s\S]{1,25}/g); // split mid-line, like a real network stream
          let i = 0;
          return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: new TextEncoder().encode(parts[i++]) } : { done: true }) }) } };
        }
        throw new Error('unexpected ' + path);
      };
    },
  });
  await wait(60);
  const d = dom.window.document;
  return { d, w: dom.window, requests, close: () => dom.window.close() };
}

test('sending a message streams the reply, shows tool progress, and adds the conversation', async () => {
  const p = await open({ chat: [
    { type: 'conversation', id: 'c1', title: 'Dentist Monday' },
    { type: 'tool', name: 'create_event', status: 'running' },
    { type: 'tool', name: 'create_event', status: 'done' },
    { type: 'text', delta: 'Added **Dentist**, Mon ' }, { type: 'text', delta: 'Oct 5, 2–3 PM.' },
    { type: 'done' },
  ] });
  p.d.getElementById('input').value = 'Dentist Monday at 2';
  p.d.getElementById('composer').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(80);
  const chat = p.requests.find((r) => r.path === '/chat');
  assert.deepEqual(chat.body, { text: 'Dentist Monday at 2' });
  assert.equal(chat.auth, 'Bearer tok');
  assert.equal(p.d.querySelector('.msg.user').textContent, 'Dentist Monday at 2');
  const reply = p.d.querySelector('.msg.assistant');
  assert.equal(reply.querySelector('strong').textContent, 'Dentist');
  assert.match(reply.textContent, /Mon Oct 5, 2–3 PM\./);
  assert.equal(reply.querySelector('.tool').textContent, 'Added an event');
  assert.equal(p.d.querySelector('#list [data-conv="c1"]').getAttribute('aria-current'), 'true');
  assert.equal(p.w.location.hash, '#c=c1');
  p.close();
});

test('a follow-up goes to the same conversation', async () => {
  const p = await open({ chat: [{ type: 'conversation', id: 'c1', title: 'x' }, { type: 'text', delta: 'ok' }, { type: 'done' }] });
  for (const t of ['first', 'second']) {
    p.d.getElementById('input').value = t;
    p.d.getElementById('composer').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(80);
  }
  const chats = p.requests.filter((r) => r.path === '/chat').map((r) => r.body);
  assert.deepEqual(chats, [{ text: 'first' }, { text: 'second', conversationId: 'c1' }]);
  p.close();
});

test('whatever Claude writes is shown as text, never run as HTML', async () => {
  const p = await open({ chat: [{ type: 'conversation', id: 'c1', title: 'x' }, { type: 'text', delta: '<img src=x onerror=alert(1)> **ok**' }, { type: 'done' }] });
  p.d.getElementById('input').value = 'hi';
  p.d.getElementById('composer').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(80);
  const reply = p.d.querySelector('.msg.assistant');
  assert.equal(reply.querySelectorAll('img').length, 0);
  assert.match(reply.textContent, /<img src=x/);
  p.close();
});

test('opening a conversation from the link shows its transcript', async () => {
  const p = await open({
    hash: '#c=c9',
    conversations: [{ id: 'c9', title: 'Trip planning', updatedAt: new Date().toISOString() }],
    transcripts: { c9: { conversation: { id: 'c9' }, transcript: [{ role: 'user', text: 'Beach trip?' }, { role: 'assistant', text: 'Added it.', tools: ['create_event'] }] } },
  });
  await wait(60);
  assert.equal(p.d.querySelector('.msg.user').textContent, 'Beach trip?');
  assert.equal(p.d.querySelector('.msg.assistant .tool').textContent, 'Added an event');
  assert.equal(p.d.querySelector('#list button').textContent.startsWith('Trip planning'), true);
  p.close();
});

test('errors in the stream are shown to you', async () => {
  const p = await open({ chat: [{ type: 'conversation', id: 'c1', title: 'x' }, { type: 'error', message: 'Something went wrong. Try again.' }, { type: 'done' }] });
  p.d.getElementById('input').value = 'hi';
  p.d.getElementById('composer').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(80);
  assert.match(p.d.querySelector('.msg.assistant').textContent, /Something went wrong/);
  p.close();
});
