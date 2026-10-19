# Dot (assistant): agent notes

Read the root `AGENTS.md` first (it covers how other tools become usable by Dot); this adds Dot's internals.

Dot runs one conversation turn per request (`api/agent.mjs` `runTurn`) on Claude
via **Bedrock** (`AnthropicBedrock`, IAM-signed, no API key; model `us.anthropic.claude-opus-4-6-v1`,
Opus 4.7+ needs AWS account approval). It acts as whoever is signed in (`var.people` in its `infra/api.tf`).

Built-in tools are defined in `api/tools.mjs`: Google Calendar (implemented in `calendar.mjs`),
`read_budget` (`budget.mjs`; Budget has no manifest, and discovery skips its 404) and
`house_control` (`house.mjs`, offered to people discovery found can use House). Everything else
is discovered (`api/discovery.mjs`), as the root guide describes.

`house_control` is Dot's one way to change another tool, and House's `POST /commands` is the one
route that accepts it. Confirmation (a `confirm` grant) is enforced in `house.mjs`, not by the
prompt: the tool has no confirm_id field, and `confirm: true` is sent only if the person has written
a new message since House asked. Keep it that way: tool results never count as their reply.
