# Dot (assistant)

`https://assistant.dot-y.co/` · permission group **`lukes_assistant`** (Luke only) · table `lukes-assistant`

Dot: a chat with Claude (Opus 5.5 on Amazon Bedrock) that can read and change Google calendars.

| Folder | What |
|---|---|
| `web/` | The chat page. Streams replies; shows which tools ran |
| `api/agent.mjs` | One conversation turn: load history, call Claude, run tools, append results. Knows nothing about HTTP |
| `api/handler.mjs` | Web entry point (Lambda Function URL, response streaming) |
| `api/store.mjs` | Conversations in DynamoDB, append-only |
| `api/tools.mjs`, `api/calendar.mjs`, `api/google.mjs` | Calendar tools; the Google service-account key is in SSM at `/family/calendar/google-key` |
| `infra/` | OpenTofu root (state key `tools/assistant/terraform.tfstate`) |
| `tests/` | Agent, calendar, handler and page tests (fake Claude, fake Google, in-memory table); live checks |

## Deploy

The Lambda needs npm packages, so it's bundled first:

```sh
npm run build
cd tools/assistant/infra && tofu apply
npm run test:live
```

## How it's built

- **Model:** `anthropic.claude-opus-5-5` through Bedrock's Messages API (`AnthropicBedrockMantle`), signed with
  the Lambda's IAM role: no API key. Effort `low` for chat. Requires the account's one-time Anthropic
  use-case form in the Bedrock console.
- **Refusals** retry on `anthropic.claude-opus-4-8` via the SDK's client-side fallback middleware
  (Bedrock has no server-side fallback).
- **Caching:** explicit breakpoints on the system prompt (with tools) and the latest message; Bedrock
  doesn't support the automatic mode. History is append-only so the cached prefix stays valid, and so
  thinking blocks are passed back unchanged.
- **Time:** each user message starts with the current date/time stamp, so the system prompt never
  changes and stays cached.
- **Streaming:** Function URL with `RESPONSE_STREAM`, not API Gateway (no streaming, 30s cap). The
  Lambda verifies the Cognito token itself (`authorization_type = NONE` on the URL).

## Adding a phone channel later

`runTurn()` in `api/agent.mjs` is the whole conversation engine. A phone/SMS handler (an SNS-triggered
Lambda for inbound texts, or a Chime SDK SIP media application for calls) would:

1. map the caller's number to Luke's user id and a conversation (e.g. one ongoing conversation per number,
   stored with `channel: 'sms'`),
2. call `runTurn({ ..., channel: 'sms', text })` without streaming,
3. send back the returned `text`.

Streaming and the Function URL only matter for the web page; the phone path doesn't use them.
