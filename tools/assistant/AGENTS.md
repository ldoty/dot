# Dot (assistant): agent notes

Read the root `AGENTS.md` first (it covers how other tools become usable by Dot); this adds Dot's internals.

Dot runs one conversation turn per request (`api/agent.mjs` `runTurn`) on Claude
via **Bedrock** (`AnthropicBedrock`, IAM-signed, no API key; model `us.anthropic.claude-opus-4-6-v1`,
Opus 4.7+ needs AWS account approval). It acts as whoever is signed in (`var.people` in its `infra/api.tf`).

Built-in tools are defined in `api/tools.mjs`: Google Calendar (implemented in `calendar.mjs`) and
`read_budget` (`budget.mjs`; Budget has no manifest, and discovery skips its 404). Everything else
is discovered (`api/discovery.mjs`), as the root guide describes.
