// Single sign-on in the browser: a tool's family-auth.js and dot-y.co/handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { accessToken } from './helpers/tokens.mjs';

const AUTH_JS = readFileSync(new URL('../web/family-auth.js', import.meta.url), 'utf8');
const HANDOFF = readFileSync(new URL('../core/portal/handoff.html', import.meta.url), 'utf8')
  .replace('<script src="/family-auth.js"></script>', `<script>${AUTH_JS}</script>`);
const AUTH = { authDomain: 'auth.dot-y.co', region: 'us-east-1' };
const TOOL = { ...AUTH, clientId: 'biomap-client', redirectUri: 'https://biomap.dot-y.co/' };
const settle = () => new Promise((r) => setTimeout(r, 20));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A page at `url` with family-auth.js loaded; navigations land in `went`, fetches in `calls`. */
function page(url, { html = '<!doctype html><body>', storage = {}, routes = {} } = {}) {
  const went = [], calls = [];
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously',
    beforeParse(w) {
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, JSON.stringify(v));
      w.TextEncoder = TextEncoder;
      w.fetch = async (u, opts = {}) => {
        const key = String(u).startsWith('/') ? String(u) : new URL(u).origin + new URL(u).pathname;
        const target = opts.headers?.['X-Amz-Target']?.split('.').pop();
        calls.push({ key, target, body: opts.body });
        const r = routes[target || key];
        if (!r) return { ok: false, status: 404, json: async () => ({}) };
        const [status, body] = typeof r === 'function' ? r(opts) : [200, r];
        return { ok: status < 300, status, json: async () => body };
      };
    },
  });
  const w = dom.window;
  if (!html.includes('family-auth')) w.eval(AUTH_JS);
  w.FamilyAuth.go = (u) => went.push(u);
  return { w, went, calls };
}

test('a tool with no sign-in goes to dot-y.co/handoff, not the login page', async () => {
  const { w, went } = page('https://biomap.dot-y.co/');
  assert.equal(await w.FamilyAuth.init(TOOL), null);
  assert.equal(w.FamilyAuth.autoLogin(), true);
  const u = new URL(went[0]);
  assert.equal(u.origin + u.pathname, 'https://dot-y.co/handoff');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(u.hash.slice(1))), { client: 'biomap-client', return: 'https://biomap.dot-y.co/' });
});

test('local dev (http://localhost) still signs in at Cognito directly', async () => {
  const { w, went } = page('http://localhost:5173/');
  w.crypto.subtle ??= globalThis.crypto.subtle;
  await w.FamilyAuth.init({ ...TOOL });
  await w.FamilyAuth.login();
  assert.match(went[0], /^https:\/\/auth\.dot-y\.co\/oauth2\/authorize\?/);
});

test('coming back with #sso= signs the tool in and clears the fragment', async () => {
  const id = accessToken({ clientId: 'biomap-client', email: 'luke@example.com' });
  const tokens = { id_token: id, access_token: 'tool-access', refresh_token: 'tool-refresh', expires_in: 3600 };
  const { w } = page(`https://biomap.dot-y.co/#sso=${b64(tokens)}`);
  const user = await w.FamilyAuth.init(TOOL);
  assert.equal(user.email, 'luke@example.com');
  assert.equal(await w.FamilyAuth.accessToken(), 'tool-access');
  assert.equal(JSON.parse(w.localStorage.getItem('family-auth')).refresh, 'tool-refresh');
  assert.equal(w.location.hash, '');
});

test('coming back with #sso_error= shows why, and does not loop', async () => {
  const { w } = page(`https://biomap.dot-y.co/#sso_error=${encodeURIComponent("You don't have access to biomap.")}`);
  await assert.rejects(w.FamilyAuth.init(TOOL), (e) => e.signIn && /access to biomap/.test(e.message));
  assert.equal(w.location.hash, '');
});

test('signing out of a tool revokes its sign-in, then signs out of dot-y.co', async () => {
  const { w, went, calls } = page('https://biomap.dot-y.co/', {
    storage: { 'family-auth': { id: 'x', access: 'a', refresh: 'tool-refresh', exp: Date.now() + 3600e3 } },
    routes: { 'https://auth.dot-y.co/oauth2/revoke': {} },
  });
  await w.FamilyAuth.init(TOOL).catch(() => {});
  await w.FamilyAuth.logout();
  assert.equal(calls.find((c) => c.key.endsWith('/revoke')).body.get('token'), 'tool-refresh');
  assert.equal(w.localStorage.getItem('family-auth'), null);
  assert.deepEqual(went, ['https://dot-y.co/#signout']);
});

// --- dot-y.co/handoff ---

const HOME_ACCESS = accessToken({ clientId: 'home-client', username: 'luke-sub' });
const homeStorage = { 'family-auth': { id: accessToken({ clientId: 'home-client', email: 'luke@example.com' }), access: HOME_ACCESS, refresh: 'r', exp: Date.now() + 3600e3 } };
const SSO = { 'biomap-client': { app: 'biomap', returns: ['https://biomap.dot-y.co/'] } };
const handoffRoutes = (over = {}) => ({
  '/config.json': { ...AUTH, clientId: 'home-client', redirectUri: 'https://dot-y.co/' },
  '/sso.json': SSO,
  InitiateAuth: { ChallengeName: 'CUSTOM_CHALLENGE', Session: 'sess', ChallengeParameters: { USERNAME: 'luke-sub' } },
  RespondToAuthChallenge: { AuthenticationResult: { IdToken: 'tid', AccessToken: 'tacc', RefreshToken: 'tref', ExpiresIn: 3600 } },
  ...over,
});
const handoff = (hash, opts) => page(`https://dot-y.co/handoff#${new URLSearchParams(hash)}`, { html: HANDOFF, ...opts });

test('handoff: gets the tool its own tokens with your dot-y.co sign-in and sends them back', async () => {
  const { w, went, calls } = handoff({ client: 'biomap-client', return: 'https://biomap.dot-y.co/' }, { storage: homeStorage, routes: handoffRoutes() });
  await settle();
  const init = JSON.parse(calls.find((c) => c.target === 'InitiateAuth').body);
  assert.deepEqual(init, { AuthFlow: 'CUSTOM_AUTH', ClientId: 'biomap-client', AuthParameters: { USERNAME: 'luke-sub' } });
  const answer = JSON.parse(calls.find((c) => c.target === 'RespondToAuthChallenge').body);
  assert.equal(answer.ChallengeResponses.ANSWER, HOME_ACCESS);
  assert.equal(answer.Session, 'sess');
  const back = new URL(went[0]);
  assert.equal(back.origin + back.pathname, 'https://biomap.dot-y.co/');
  const sent = JSON.parse(Buffer.from(new URLSearchParams(back.hash.slice(1)).get('sso'), 'base64url'));
  assert.deepEqual(sent, { id_token: 'tid', access_token: 'tacc', refresh_token: 'tref', expires_in: 3600 });
  assert.equal(w.sessionStorage.getItem('family-handoff'), null);
});

test('handoff: never sends tokens to a URL not registered for that tool', async () => {
  for (const ret of ['https://evil.example/', 'https://budget.dot-y.co/', 'http://biomap.dot-y.co/']) {
    const { w, went, calls } = handoff({ client: 'biomap-client', return: ret }, { storage: homeStorage, routes: handoffRoutes() });
    await settle();
    assert.deepEqual(went, [], ret);
    assert.equal(calls.some((c) => c.target), false, ret);
    assert.match(w.document.getElementById('error').textContent, /isn't set up/);
  }
  const { went } = handoff({ client: 'unknown-client', return: 'https://biomap.dot-y.co/' }, { storage: homeStorage, routes: handoffRoutes() });
  await settle();
  assert.deepEqual(went, []);
});

test('handoff: not signed in to dot-y.co -> sign in there first, keeping the request', async () => {
  const { w, went, calls } = handoff({ client: 'biomap-client', return: 'https://biomap.dot-y.co/' }, { routes: handoffRoutes() });
  w.crypto.subtle ??= globalThis.crypto.subtle;
  await settle();
  assert.equal(calls.some((c) => c.target), false);
  const u = new URL(went[0]);
  assert.equal(u.searchParams.get('client_id'), 'home-client');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://dot-y.co/handoff');
  assert.equal(JSON.parse(w.sessionStorage.getItem('family-handoff')).client, 'biomap-client');
});

test('handoff: not a member -> back to the tool with the reason', async () => {
  const routes = handoffRoutes({
    RespondToAuthChallenge: () => [400, { __type: 'UserLambdaValidationException', message: "PreTokenGeneration failed with error You don't have access to biomap. Ask an admin to add you." }],
  });
  const { went } = handoff({ client: 'biomap-client', return: 'https://biomap.dot-y.co/' }, { storage: homeStorage, routes });
  await settle();
  const back = new URL(went[0]);
  assert.equal(new URLSearchParams(back.hash.slice(1)).get('sso_error'), "You don't have access to biomap. Ask an admin to add you.");
});
