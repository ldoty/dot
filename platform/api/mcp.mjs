// A tool's remote MCP server, for Claude Code: Streamable HTTP, stateless, JSON responses (no SSE,
// no sessions), so it runs in the tool's own Lambda behind API Gateway. Symlinked into each tool that
// serves POST /mcp.
//
// Claude Code signs in as the person with the tool's MCP client (platform/modules/family-app,
// mcp_callback_urls): the sign-in page, code + PKCE, back to localhost. Every call carries that
// person's access token, checked like any other (authorizer, then verifyAccessToken in the tool), and
// each tool's run() acts only with their access. Discovery: GET /.well-known/oauth-protected-resource
// (RFC 9728) names the pool as the authorization server; a 401 says where that is (challenge()).
//
//   const mcp = mcpServer({ name, title, version, instructions, tools: [{ name, description, inputSchema, annotations?, run(args, ctx) }] });
//   (tools may instead be async (ctx) -> [...]: each person's own, as platform/mcp discovers them)
//   const { status, body } = await mcp(parsedBody, ctx);   // body null: answer 202 with nothing
//
// structuredContent must be an object, so an array (a list of reminders) goes back as text only.
// A run() that throws toolError(msg) answers isError with msg, for the model to read; anything else is
// logged and answers a plain "failed", so internals never reach the conversation.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/** An error the model should see (a bad argument, a file that isn't there) */
export const toolError = (message) => Object.assign(new Error(message), { toolError: true });

/** RFC 9728 metadata: this resource, signed in by the pool */
export const protectedResource = ({ resource, issuer, scopes = ['openid', 'email', 'profile'] }) => ({
  resource, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'],
});

/** The WWW-Authenticate header on a 401, pointing Claude Code at the metadata */
export const challenge = (metadataUrl) => `Bearer resource_metadata="${metadataUrl}"`;

export function mcpServer({ name, title, version = '1', instructions, tools, log = console }) {
  const toolsFor = typeof tools === 'function' ? tools : async () => tools;

  async function one(msg, ctx) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'invalid request');
    const { id, method, params = {} } = msg;
    // Notifications (no id) and responses to us get nothing back
    if (id === undefined || id === null) return null;
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, title, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: (await toolsFor(ctx)).map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = (await toolsFor(ctx)).find((t) => t.name === params.name);
        if (!tool) return rpcError(id, -32602, `no tool ${String(params.name).slice(0, 60)}`);
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
        try {
          const out = await tool.run(args, ctx);
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
          return rpcResult(id, { content: [{ type: 'text', text }], ...(out && typeof out === 'object' && !Array.isArray(out) ? { structuredContent: out } : {}) });
        } catch (e) {
          if (!e.toolError) log.error('tool failed', tool.name, e);
          return rpcResult(id, { content: [{ type: 'text', text: e.toolError ? e.message : `${tool.name} failed` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `no method ${method.slice(0, 60)}`);
    }
  }

  return async (body, ctx) => {
    if (Array.isArray(body)) return { status: 400, body: rpcError(null, -32600, 'one message per request') };
    const out = await one(body, ctx);
    return out ? { status: 200, body: out } : { status: 202, body: null };
  };
}
