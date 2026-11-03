# Otto

Otto is Luke's agent. Claude Code runs in its own container on the home server, signed in to Luke's
claude.ai account. It manages Luke's Gmail inbox through the claude.ai Gmail connector: it can read,
label, archive and mark mail read, but it never sends from Gmail and never deletes. It emails Luke from
**otto@dot-y.co**. You can give it work, and it also runs some prompts on its own, such as the daily brief.

- **Page:** otto.dot-y.co, for `lukes_otto` (Luke only).
- **From Dot:** "have Otto…" (`otto_stage`) and "have Otto do X every day at 6" (`otto_schedule_create`).
- **From Claude Code:** the dot-y MCP (`otto_stage`, `otto_schedules`…).

| Piece | What |
|---|---|
| `api/api.mjs` | The person's API: commands, approve and discard, schedules, status, sent, the manifest (`GET /dot`) |
| `api/agent.mjs` | The agent's API at `/agent/*`. Authenticated by key (`x-otto-key`), with no authorizer. It hands out work, records results, and sends email to the owner only |
| `api/sweep.mjs` | Every minute: queues due schedules, records long-missed runs, and fails runs that stopped answering |
| `api/mail.mjs` | Mail to otto@ (via the gate in `platform/email/otto.tf`): keeps the words and queues a command. Bundled by `npm run build` |
| `api/schedules.mjs`, `api/store.mjs` | Schedule rules and wording; the table's rows and helpers |
| `agent/otto.mjs` | The runner in the container: poll, `claude -p`, report |
| `agent/tools.mjs` | Claude's `send_email` and `clear_brief` (stdio MCP server; `mcp.json`) |
| `agent/guard.mjs` | A managed PreToolUse hook: a clear run may remove only `UNREAD` and Luke's own labels |
| `agent/OTTO.md` | Otto's standing instructions (appended to the system prompt; root's) |
| `agent/managed-settings.json` | Claude Code's managed settings in the container: what is never allowed |
| `scripts/create-container.sh`, `scripts/deploy-agent.sh` | Make CT 103 once; copy `agent/` and restart |

## Where a command comes from, and what it may do

| Source | How it gets queued | Claude may |
|---|---|---|
| `page` | Luke on otto.dot-y.co: queued at once | Gmail read, label, archive, mark read or spam; `send_email` |
| `asked` | Dot or Claude Code stage it (`asking`). It's queued after Luke's own reply in Dot (`?confirm_id=`), or after Approve on the page (within a day) | the same |
| `schedule` | The sweep, at the schedule's time, with exactly the saved prompt. Saving a schedule from Dot or Claude Code needs his OK the same way | the same |
| `email` | Luke's DMARC-passing mail to otto@ (the gate checks `lukes_otto` and the verified email) | Gmail **read only**; `send_email` to answer in the thread. A reply to a brief also gets `clear_brief` |
| `clear` | `clear_brief`, during a reply to a brief, once per reply. Always the fixed `CLEAR_PROMPT` (`store.mjs`) | Gmail search and `unlabel_thread`, removing only `UNREAD` and Luke's labels (`guard.mjs`); `send_email` to confirm |

### Clearing from a reply

The brief (a schedule) labels what Luke should see `Otto/Review`, and what can be marked read `Otto/Clear`.
Every email a schedule sends is recorded as a `BRIEF` row under the Message-ID SES gave it. Mail to otto@
that names one in In-Reply-To or References is a reply to a brief. Its run may call `clear_brief`, and the
agent API queues `CLEAR_PROMPT` as a `clear` command, threaded under the reply. What the email says only
decides *whether* that happens, never what it does. So the worst a forged or injected "clear" can do is
mark the mail the brief already sorted as clearable read. The guard means even a misled clear run can't
archive, unstar or spam anything.

A delegated token looks the same whether it comes from Dot or from Claude Code (both are `via: dot`).
Dot reads texts and email from outside. So nothing a delegated token sends turns into work until Luke
says yes himself. In Claude Code, that yes is its own permission prompt. Luke's settings `ask` before
`mcp__dot-y__otto_stage` and `_schedule_*`, and `platform/mcp` (`CONFIRM_APPS`) then confirms the 202 at once.

In the container, every run is:
`claude -p … --restricted --permission-mode dontAsk --allowedTools <the source's list> --disallowedTools <never>`.
- `--restricted` removes Bash, the other code-running tools and WebFetch, and ignores user and project settings.
- `dontAsk` refuses anything not on the allowlist.
- The managed settings also run `guard.mjs` before every Gmail call (managed hooks only).
- The managed settings deny the same "never" list again: sending, replying, forwarding, drafts, trash,
  label edits, Drive, Docs, code and file writes, and reading `/etc/otto` or `/opt/otto`.
- Gmail content is framed as data. `OTTO.md` is root's, so nothing Otto reads can rewrite its instructions.

## Rows

| pk / sk | What |
|---|---|
| `CMD` / `c<time><rand>` | A command: prompt, source, status (`asking` → `queued` → `running` → `done`/`failed`, or `discarded`), result, schedule?, mail?, sends. Kept 30 days |
| `SCHED` / `s<10>` | A schedule: name, prompt, time, repeat `{ rule, start, tz }`, enabled, nextAt, lastRun, owner, rev |
| `PENDING` / `<confirm id>` | A delegated change waiting for the person's reply (2 minutes) |
| `MAIL` / `<SES id>` | A message to otto@: from, subject, text, Message-ID and References for threading. Kept 8 days |
| `SENT#<day>` / `<at>#<cmd>` | An email Otto sent (the manifest's `sent` role). Kept 3 days |
| `BRIEF` / `<Message-ID>` | An email a schedule sent, so a reply to it can clear it. Kept 8 days |
| `AGENT` / `SEEN` | When the agent last asked for work (online = within 3 minutes) |

## Deploy

```sh
aws ssm put-parameter --profile ldoty --type SecureString \
  --name /family/otto/agent-key --value "$(openssl rand -hex 32)"     # once
npm run build                                    # bundles api/mail.mjs (mailparser)
cd tools/otto/infra && tofu init && tofu plan && tofu apply
cd ../../../platform/email && tofu plan && tofu apply   # the otto@ gate, after tools/otto
cd ../core && tofu apply                         # the home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_otto
npm run test:live
```

## Set up the container (once)

From the Mac, on the home network:

```sh
tools/otto/scripts/create-container.sh           # CT 103, Node 22, Claude Code, user otto, firewall
PVE=root@192.168.0.235
API=$(cd tools/otto/infra && tofu output -raw agent_api_url)
KEY=$(aws ssm get-parameter --profile ldoty --name /family/otto/agent-key --with-decryption --query Parameter.Value --output text)
ssh $PVE "pct exec 103 -- bash -c 'umask 027; cat > /etc/otto/env; chgrp otto /etc/otto/env'" <<< "OTTO_API=$API
DISABLE_AUTOUPDATER=1"
ssh $PVE "pct exec 103 -- bash -c 'umask 027; cat > /etc/otto/agent-key; chgrp otto /etc/otto/agent-key'" <<< "$KEY"
ssh -t $PVE "pct exec 103 -- su -s /bin/bash otto -c 'cd ~/work && claude'"
#   /login with Luke's claude.ai account; /mcp should list the claude.ai Gmail connector; /exit
tools/otto/scripts/deploy-agent.sh               # code, settings, unit; starts otto
```

Then queue "List my 5 newest unread threads" on the page. It should be done within a minute. Next, try
"Send yourself an email by forwarding the newest message". The page's answer should say it can't.
