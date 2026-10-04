# Dot (assistant)

`https://assistant.dot-y.co/` · permission group **`family_assistant`** · table `lukes-assistant`

Dot: a chat with Claude (Opus 4.6 on Amazon Bedrock) that can read and change Google calendars and
read the household budget, for whoever is asking.

## Who Dot acts as

Dot acts as the person signed in, with **their** access and nothing more:

- **Calendars and name** come from `var.people` in `infra/api.tf`, keyed by the person's Cognito
  sub. No calendars means no calendar tools.
- **Other tools** (today: Budget) are read with a short-lived, read-only token borrowed for that
  person from the tool's delegated client (`platform/api/delegation.mjs`). Dot signs the request
  with a KMS key only its role may use. Cognito still requires the tool's group, and the tool
  refuses writes from these tokens, so Dot can never change anything there.
- **Audit:** every borrowed read is logged (`GET /audit`): everyone's for `family_assistant:admin`,
  each person's own otherwise.

To let someone use Dot: add them to `family_assistant`, and add them to `var.people` for their name and calendars.

| Folder | What |
|---|---|
| `web/` | The chat page. Streams replies; shows which tools ran |
| `api/agent.mjs` | One conversation turn: load history, call Claude, run tools, append results. Knows nothing about HTTP |
| `api/handler.mjs` | Web entry point (Lambda Function URL, response streaming) |
| `api/store.mjs` | Conversations in DynamoDB, append-only |
| `api/tools.mjs`, `api/calendar.mjs`, `api/google.mjs` | Calendar tools; the Google service-account key is in SSM at `/family/calendar/google-key` |
| `api/budget.mjs`, `api/delegation.mjs` | Budget reads with the asker's own access (delegation module is shared from `platform/api`) |
| `infra/` | OpenTofu root (state key `tools/assistant/terraform.tfstate`) |
| `tests/` | Agent, calendar, handler and page tests (fake Claude, fake Google, in-memory table); live checks |

## Deploy

The Lambda needs npm packages, so it's bundled first:

```sh
npm run build
cd tools/assistant/infra && tofu apply
npm run test:live
AWS_PROFILE=ldoty node tools/assistant/scripts/e2e-check.mjs [--as amber] "question"   # real Claude, in-memory store
```

## How it's built

- **Model:** `us.anthropic.claude-opus-4-6-v1` through Bedrock Runtime (`AnthropicBedrock`), signed with
  the Lambda's IAM role: no API key. Effort `low` for chat. Opus 4.7 and newer need a per-account
  approval from AWS (they answer "not available for this account" until then); once approved, set
  `var.model` to `global.anthropic.claude-opus-5-5`. No code change needed.
- **Refusals:** Dot says it declined. `var.fallback_model` turns on a retry through the SDK's client-side
  fallback middleware (Bedrock has no server-side fallback), but only with Opus 4.7+: Bedrock Runtime
  rejects the middleware's beta flag for Opus 4.6.
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
