# dot-y MCP server

The family's tools in Claude Code, as the person signed in. One remote MCP server (`api/server.mjs`, a
Lambda behind API Gateway) for every tool: it finds them the way Dot does and offers each manifest
operation as `<tool>_<operation>`. No tool has MCP code of its own.

| File | What |
|---|---|
| `api/server.mjs` | Routes: sign-in discovery and pass-through, `POST /mcp` |
| `api/connect.mjs` | For one person: the published tools, a borrowed token on each (signed as `mcp`), their manifests, as MCP tools |
| `api/mcp.mjs`, `mcp-auth.mjs` | Symlinks to `platform/api`: the MCP protocol (stateless, JSON), and sign-in passed through to Cognito |
| `main.tf` | OpenTofu root (state key `platform/mcp/terraform.tfstate`): group `family_mcp`, Claude Code's client, the server |

## Access

1. **Sign-in**: Claude Code's own client (sign-in page, code + PKCE, back to `localhost:33419`), for members
   of `family_mcp`; the pre-token gate's rule at `/family/apps/<clientId>`. No custom auth on it.
2. **Each tool**: the server borrows a short-lived token for the person on the tool's delegated client,
   signed with core's `mcp` key (`delegation_signers`, which lists the people it may act for). A tool
   takes part only if its `delegates` lists `"mcp"`, and the Cognito group gate still applies.
3. **What it may do**: what the tool allows a borrowed token: reads, and the writes its manifest
   declares. A write that needs the person's OK (202 `confirm_id`) isn't confirmed from here, because
   in Claude Code the model could answer for them; it says where to do it instead. The exception is
   the tools in `CONFIRM_APPS` (`main.tf`), today only Otto (Luke's choice). For those, the OK is Claude
   Code's own permission prompt, from `ask` rules on `mcp__dot-y__otto_stage` and `mcp__dot-y__otto_schedule_*`
   in Luke's `~/.claude/settings.json`, and the server sends the confirmation at once. Those rules are
   the human gate, so keep them.

Sign-in passes through this API (`mcp-auth.mjs`) because Claude Code sends RFC 8707 `resource`, which
makes Cognito's code exchange fail. The pass-through forwards only the standard PKCE fields, for this
client only, and never logs tokens.

## Deploy and connect

```sh
cd platform/core && tofu apply       # the mcp signer (once)
cd platform/mcp && tofu init && tofu apply
# then add "mcp" to a tool's delegates and apply it
tofu output -raw claude_mcp_add      # run it, then /mcp in Claude Code to sign in
```
