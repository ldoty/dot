// Shared sign-in for family tools: Cognito managed login with auth code + PKCE.
// Each tool is its own origin and app client, so tokens never cross between tools.
// Tokens stay in this origin's localStorage; the 30-day refresh token keeps people
// signed in, and Cognito re-checks group membership on every refresh.
//
//   FamilyAuth.init({ authDomain, clientId, redirectUri }) -> Promise<idClaims | null>
//   FamilyAuth.login()  FamilyAuth.logout()  FamilyAuth.accessToken() -> Promise<string | null>
//   FamilyAuth.autoLogin() -> true if it redirected to sign-in (tools call this instead of showing a button)
(function () {
  var KEY = "family-auth", PKCE = "family-auth-pkce", TRIED = "family-auth-tried", cfg;

  function b64url(bytes) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function rand() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }
  function decode(jwt) {
    var p = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  }
  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function store(res, prev) {
    var t = { id: res.id_token, access: res.access_token, refresh: res.refresh_token || (prev && prev.refresh), exp: Date.now() + res.expires_in * 1000 };
    try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) {}
    return t;
  }
  function tokenRequest(params) {
    params.client_id = cfg.clientId;
    return fetch("https://" + cfg.authDomain + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }).then(function (r) {
      if (!r.ok) throw new Error("Sign-in failed (" + r.status + "). Try again.");
      return r.json();
    });
  }

  function handleCallback() {
    var q = new URLSearchParams(location.search);
    if (!q.has("code") && !q.has("error")) return Promise.resolve();
    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(PKCE)) || {}; sessionStorage.removeItem(PKCE); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.hash);
    if (q.has("error")) return Promise.reject(new Error(q.get("error_description") || q.get("error")));
    if (q.get("state") !== saved.state) return Promise.reject(new Error("Sign-in expired. Try again."));
    return tokenRequest({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: cfg.redirectUri, code_verifier: saved.verifier })
      .then(function (res) { store(res); });
  }

  function accessToken() {
    var t = load();
    if (!t) return Promise.resolve(null);
    if (t.exp - 60000 > Date.now()) return Promise.resolve(t.access);
    if (!t.refresh) { clear(); return Promise.resolve(null); }
    return tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })
      .then(function (res) { return store(res, t).access; }, function () { clear(); return null; });
  }

  window.FamilyAuth = {
    init: function (c) {
      cfg = c;
      if (location.hostname === "localhost") cfg.redirectUri = location.origin + "/";
      return handleCallback().then(accessToken).then(function (tok) { return tok ? decode(load().id) : null; });
    },
    accessToken: accessToken,
    // Someone signed in on dot-y.co (or another tool) still has a session at the login
    // page, so this round trip comes straight back signed in, with no password prompt.
    // At most one try a minute, so a failed sign-in shows the page instead of looping.
    autoLogin: function () {
      var last = 0;
      try { last = Number(sessionStorage.getItem(TRIED)) || 0; } catch (e) {}
      if (Date.now() - last < 60000) return false;
      try { sessionStorage.setItem(TRIED, String(Date.now())); } catch (e) {}
      window.FamilyAuth.login();
      return true;
    },
    login: function () {
      var verifier = rand(), state = rand();
      sessionStorage.setItem(PKCE, JSON.stringify({ verifier: verifier, state: state }));
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(function (h) {
        location.href = "https://" + cfg.authDomain + "/oauth2/authorize?" + new URLSearchParams({
          response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
          scope: "openid email profile", state: state, code_challenge: b64url(h), code_challenge_method: "S256",
        });
      });
    },
    logout: function () {
      clear();
      location.href = "https://" + cfg.authDomain + "/logout?" + new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
    },
  };
})();
