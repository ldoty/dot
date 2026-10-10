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
| `api/sms.mjs` | Texting entry point: one turn for a text, reply sent through Twilio (below) |
| `api/store.mjs` | Conversations in DynamoDB, append-only |
| `api/tools.mjs`, `api/calendar.mjs`, `api/google.mjs` | Calendar tools; the Google service-account key is in SSM at `/family/calendar/google-key` |
| `api/budget.mjs`, `api/delegation.mjs` | Budget reads with the asker's own access (delegation module is shared from `platform/api`) |
| `infra/` | OpenTofu root (state key `tools/assistant/terraform.tfstate`) |
| `tests/` | Agent, calendar, handler and page tests (fake Claude, fake Google, in-memory table); live checks |

## Deploy

The Lambda needs npm packages, so it's bundled first:

```sh
npm run build
cd tools/assistant/infra && tofu apply   # before tools/sms, which reads the SMS worker's ARN
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

## Texting Dot

Family members can text Dot at (864) 568-4810 (the Dot-y program; Twilio, A2P 10DLC). The
SMS tool's webhook (`tools/sms/api/webhook.mjs`) checks Twilio's signature, that the number is
opted in, and that it is the **verified `phone_number` of a `family_assistant` member** in Cognito.
It then invokes `lukes-assistant-sms` (`api/sms.mjs`) asynchronously, because a turn can outlast
Twilio's 15-second timeout. The worker runs `runTurn()` as that person with `channel: 'sms'`
(same tools, same access, audits say `sms`) and texts the reply through the Messaging Service.

- One texting conversation carries on until it has been quiet for 6 hours; the next text starts a new one.
  They show up on the web page like any other conversation.
- Replies are plain text, split into at most three texts, and never carry links (the campaign is
  registered without embedded links): web addresses are replaced before sending.
- The worker runs one turn at a time (reserved concurrency 1; other texts wait in line), never
  retries a turn, and drops a text that has waited more than 15 minutes.

To let someone text Dot: they opt in at dot-y.co/sms with their number, and you set that number,
verified, on their Cognito user:

```sh
aws cognito-idp admin-update-user-attributes --profile ldoty --user-pool-id <pool> --username <sub> \
  --user-attributes Name=phone_number,Value=+1XXXXXXXXXX Name=phone_number_verified,Value=true
```
