// Archive API: the family's documents, kept by Molly. Routes:
//   GET  /.well-known/oauth-protected-resource[/mcp]  (no token) where Claude Code signs in (RFC 9728)
//   GET  /.well-known/oauth-authorization-server, GET /oauth/authorize, POST /oauth/token  (no token)
//        sign-in passed through to the pool's own, for the MCP client only (mcp-auth.mjs)
//   POST /mcp    the MCP server for Claude Code (mcp.mjs; MCP client tokens only)
//   GET  /mcp    405: no server-sent stream, every answer comes back on its POST
// MCP tokens and the page's tokens are for different clients, and each route takes only its own,
// so a token Claude Code holds can't drive the page's routes and the other way round.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { verifyAccessToken } from './verify-token.mjs';
import { challenge, mcpServer, protectedResource } from './mcp.mjs';
import { mcpAuth } from './mcp-auth.mjs';
import { archiveTools, INSTRUCTIONS } from './tools.mjs';

const json = (statusCode, body, headers = {}) => ({
  statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

/** deps: group, issuer, clientId (the page's), mcpClientId, publicUrl (the API's own https URL), authDomain, fetch? */
export function createApi(deps) {
  const { group, issuer, clientId, mcpClientId, publicUrl } = deps;
  const auth = mcpAuth({ publicUrl, authDomain: deps.authDomain, clientId: mcpClientId, fetch: deps.fetch });
  const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const mcp = mcpServer({ name: 'archive', title: 'Molly’s archive', instructions: INSTRUCTIONS, tools: archiveTools(deps) });

  async function person(event, client) {
    try {
      const claims = await verifyAccessToken(event.headers, { issuer, clientId: client, group });
      // A token bound to a resource (RFC 8707: Claude Code binds its tokens to the MCP URL) must be bound to ours
      if (claims.aud !== undefined && claims.aud !== `${publicUrl}/mcp`) throw Object.assign(new Error('token is for another resource'), { status: 401 });
      return { claims };
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      const headers = client === mcpClientId && e.status === 401 ? { 'www-authenticate': challenge(metadataUrl) } : {};
      return { denied: json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' }, headers) };
    }
  }

  function parse(event) {
    if (!event.body) return {};
    try {
      return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch {
      return undefined;
    }
  }

  return async (event) => {
    switch (event.routeKey) {
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        // The authorization server is ours (the pass-through), so discovery finds it with no settings
        return json(200, protectedResource({ resource: `${publicUrl}/mcp`, issuer: publicUrl }));
      case 'GET /.well-known/oauth-authorization-server':
        return json(200, auth.metadata());
      case 'GET /oauth/authorize': {
        const r = auth.authorize(event.queryStringParameters);
        return r.location ? { statusCode: 302, headers: { location: r.location }, body: '' } : json(r.status, { error: r.error });
      }
      case 'POST /oauth/token': {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body;
        const r = await auth.token(raw);
        return json(r.status, r.body, { 'cache-control': 'no-store' });
      }
      case 'GET /mcp':
        return { statusCode: 405, headers: { allow: 'POST' }, body: '' };
      case 'POST /mcp': {
        const { claims, denied } = await person(event, mcpClientId);
        if (denied) return denied;
        const body = parse(event);
        if (body === undefined) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad json' } });
        console.log(JSON.stringify({ mcp: String(body.method).slice(0, 40), tool: body.params?.name, user: claims.username }));
        const out = await mcp(body, { claims, sub: claims.sub, username: claims.username });
        return out.body ? json(out.status, out.body) : { statusCode: out.status, body: '' };
      }
      default:
        return json(404, { error: 'no route' });
    }
  };
}

let live;
export const handler = async (event) => (live ??= createApi({
  group: process.env.GROUP,
  issuer: process.env.ISSUER,
  clientId: process.env.CLIENT_ID,
  mcpClientId: process.env.MCP_CLIENT_ID,
  publicUrl: process.env.PUBLIC_URL,
  authDomain: process.env.AUTH_DOMAIN,
}))(event);
