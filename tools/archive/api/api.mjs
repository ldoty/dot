// Archive API: the family's documents, kept by Molly. No routes yet: the catalog, drawers and files
// come next, and Claude Code will reach them through platform/mcp (this tool's GET /dot manifest).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { verifyAccessToken } from './verify-token.mjs';

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** deps: group, issuer, clientId */
export function createApi({ group, issuer, clientId }) {
  return async (event) => {
    try {
      await verifyAccessToken(event.headers, { issuer, clientId, group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    return json(404, { error: 'no route' });
  };
}

let live;
export const handler = async (event) => (live ??= createApi({
  group: process.env.GROUP,
  issuer: process.env.ISSUER,
  clientId: process.env.CLIENT_ID,
}))(event);
