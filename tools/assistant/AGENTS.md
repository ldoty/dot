# Dot (assistant): agent notes

Read the root `AGENTS.md` first (it covers how other tools become usable by Dot); this adds Dot's internals.

Dot runs one conversation turn per request (`api/agent.mjs` `runTurn`) on Claude
via **Bedrock** (`AnthropicBedrock`, IAM-signed, no API key; model `us.anthropic.claude-opus-4-6-v1`,
Opus 4.7+ needs AWS account approval). It acts as whoever is signed in (`var.people` in its `infra/api.tf`).

Built-in tools are defined in `api/tools.mjs`: the calendar tools (`calendars.mjs`, calling `tools/calendars`
as the person: which calendars and which they may change are Calendars' grants; Dot holds no Google key),
`read_budget` (`budget.mjs`; Budget has no manifest, and discovery skips its 404) and
`house_control` (`house.mjs`, offered to people discovery found can use House), `lists_change`
(`lists.mjs`, likewise for Lists). Everything else
is discovered (`api/discovery.mjs`), as the root guide describes.

`house_control`, `lists_change` and the calendar tools are Dot's only ways to change another tool. Confirmations (a
House `confirm` grant, deleting a list or an event) are enforced in `confirm.mjs`, not by the prompt: the tools
have no confirm_id field, and `confirm: true` is sent only if the person has written a new message
since that tool asked. Keep it that way: tool results never count as their reply.

**Memory** (`api/memory.mjs`): Dot keeps notes (`remember`, `forget`, `recall`), household (every
member's Dot reads them; admins edit them on the page) or personal (only that person's Dot; only they
edit them). Dot decides what's worth saving. Every note goes into the instructions each turn, last, so
a new note disturbs as little of the cached prompt as possible; past `BUDGET_CHARS` Dot gets a
one-line index and recalls the rest. Notes say who and which conversation they came from. They only
steer what Dot tries: every action still runs with the person's own access. The instructions forbid
saving anything because content Dot read asks it to; code can't tell a forwarded email from the
person's words, so the page ("What Dot knows") and Dot saying what it saved are the backstop.
