// Sign-in for a tool's MCP server, in front of the pool's own (auth.dot-y.co). Claude Code follows the
// MCP spec and sends RFC 8707 `resource` at both steps; Cognito takes it on /oauth2/authorize but its
// token exchange then fails (invalid_grant, before any token is made). So the tool publishes its own
// authorization-server metadata (RFC 8414) whose two endpoints pass straight through to Cognito with
// the standard PKCE parameters only, as the pages sign in. Cognito still does all of the signing in,
// and the pre-token gate still decides; this only forwards, for the tool's MCP client and no other.
// Symlinked into each tool that serves POST /mcp.
//
//   const auth = mcpAuth({ publicUrl, authDomain, clientId, fetch? });
//   auth.metadata()          -> RFC 8414 JSON
//   auth.authorize(query)    -> { status: 302, location } or { status: 400, error }
//   auth.token(formBody)     -> { status, body } (Cognito's answer as it came; never logged)

const AUTHORIZE = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];
const TOKEN = {
  authorization_code: ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier'],
  refresh_token: ['grant_type', 'client_id', 'refresh_token'],
};

export function mcpAuth({ publicUrl, authDomain, clientId, scopes = ['openid', 'email', 'profile'], fetch = globalThis.fetch, log = console }) {
  return {
    metadata: () => ({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: Object.keys(TOKEN),
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: scopes,
    }),

    authorize(query = {}) {
      // Only our client, only PKCE with S256: anything else isn't Claude Code signing in to this tool
      if (query.client_id !== clientId) return { status: 400, error: 'unknown client' };
      if (query.response_type !== 'code' || query.code_challenge_method !== 'S256' || !query.code_challenge) return { status: 400, error: 'code with S256 PKCE only' };
      const q = new URLSearchParams();
      for (const k of AUTHORIZE) if (typeof query[k] === 'string') q.set(k, query[k]);
      return { status: 302, location: `https://${authDomain}/oauth2/authorize?${q}` };
    },

    async token(raw) {
      const form = new URLSearchParams(raw || '');
      const keep = TOKEN[form.get('grant_type')];
      if (!keep) return { status: 400, body: { error: 'unsupported_grant_type' } };
      if (form.get('client_id') !== clientId) return { status: 401, body: { error: 'invalid_client' } };
      const out = new URLSearchParams();
      for (const k of keep) if (form.has(k)) out.set(k, form.get(k));
      const r = await fetch(`https://${authDomain}/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: out.toString(),
      });
      const body = await r.json().catch(() => ({ error: 'server_error' }));
      // The error, never the tokens
      if (!r.ok) log.warn(JSON.stringify({ token: form.get('grant_type'), status: r.status, error: body.error, description: body.error_description }));
      return { status: r.status, body };
    },
  };
}
