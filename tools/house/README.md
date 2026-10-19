# House

`https://house.dot-y.co/` · permission group **`family_house`** (admins: `family_house:admin`)

The house’s lights and switches from Home Assistant, by room, for the people allowed to see them,
and for Dot as whoever is asking. Home Assistant runs at home and is never reachable from the
internet: a relay at home dials out to this tool and reports what the ceiling allows.

```
Dot ─┐                    AWS                              House
     ├─ HTTPS ─→ API Lambda ←─ table ─→ relay Lambda ←── WebSocket ── relay (container) ──→ Home Assistant
Page ┘          (grants)                                (dials out)     (ceiling)          (local only)
```

| Folder | What |
|---|---|
| `web/` | The page: a card per room, refreshed every 15 s while visible |
| `api/` | `api.mjs` (signed in: `/home`, `/commands`, `/dot`), `access.mjs` (admins: grants, groups, the log), `relay-ws.mjs` (the relay’s WebSocket routes), `grants.mjs` (who may do what). `verify-token.mjs`, `dot-manifest.mjs` link to `platform/api/`; `protocol.mjs` links to `relay/` |
| `relay/` | Runs at home, not in AWS: `relay.mjs`, `ceiling.json` (what’s exposed at all) and its check `ceiling.mjs`, `protocol.mjs` (messages, shared with the Lambda), `house-relay.service` |
| `infra/` | OpenTofu root (state key `tools/house/terraform.tfstate`); `relay.tf` is the WebSocket API |
| `scripts/` | `deploy-relay.sh`: copy `relay/` to the container and restart it |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Routes

| Route | Who | What |
|---|---|---|
| `GET /home[?area=]` | members, Dot | Rooms and devices the caller may read, each with their level; how fresh the picture is |
| `POST /commands` | members, Dot | `{ entity_id, action, data?, confirm_id? }`: 200 done, 202 confirm first, 403 not theirs, 502 refused/failed, 504 offline. Never queued |
| `GET /dot` | Dot | The manifest: `house_state` |
| `GET /access` | admins, not Dot | Grants, the family's groups, the people in `family_house` (named as dot-y.co/family names them), rooms and devices to pick from |
| `PUT`/`DELETE /grants/{id}` | admins, not Dot | `rev`-checked (409 + current) |
| `GET /log` | admins, not Dot | The last 7 days of commands, newest first |
| WebSocket `$connect` | the relay, `x-house-key` | Checked against SSM `/family/house/relay-key` |
| WebSocket `sync` | the relay | A full snapshot (on connect, every 5 min) or changes |
| WebSocket `result` | the relay | How a command went |

A command: the API checks the person's grant and the device's actions, sends it to the relay's
connection (it must run within 5 s), and waits for the `result`. The relay checks it against its
own ceiling again, calls Home Assistant, and answers.

## Rows

| pk / sk | What |
|---|---|
| `RELAY` / `CONN` | The relay’s connection id, `connectedAt`, `lastSync` |
| `AREA` / `<area id>` | Room name, as Home Assistant has it |
| `ENTITY` / `<entity id>` | `name`, `area`, `domain`, `state`, `attrs` (only the ceiling’s), `updated`, `actions` (from the ceiling) |
| `RESULT` / `<command id>` | `ok`, `error`: the relay’s answer, read by the waiting API (expires in a day) |
| `PENDING` / `<confirm id>` | A command waiting for its confirmation: same person, same command, 2 minutes, once |
| `CMD#<UTC day>` / `<ISO>#<id>` | Audit: who, via (page/dot), device, action, data, outcome (done, denied, failed, offline, timeout). Kept a year |
| `GRANT` / `<id>` | `{ who, where, level }` (see `api/grants.mjs`), `rev`, `changedBy`, `changedAt` |

## Access

Admins manage grants under **People & access** on the page, with the last week's activity. Groups are
the family's (dot-y.co/family, `platform/family`); a grant names one by id.

Two independent checks: the **ceiling** (`relay/ceiling.json`, enforced by the relay; AWS can’t
change it) decides what exists at all, and **grants** (in the table) decide who may read or control
what inside it. No grant, no access; admins have control everywhere. Dot reads with the asker’s
own grants, and sends commands the same way: `POST /commands` is the one change it may make.

## The relay

A Debian container on the home server (Proxmox CT 102 `relay`), Node 22, user `relay`. It holds:
- `/etc/house-relay/ha-token`: a long-lived token of the **non-admin** Home Assistant user `relay`
- `/etc/house-relay/house-key`: the same value as SSM `/family/house/relay-key`
- `/etc/house-relay/env`: `HOUSE_WS_URL=<tofu output relay_url>`

```sh
tools/house/scripts/deploy-relay.sh            # copy relay/, restart, show the log
```

## Deploy

```sh
aws ssm put-parameter --profile ldoty --type SecureString \
  --name /family/house/relay-key --value "$(openssl rand -hex 32)"     # once
cd tools/house/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `family_house`,
API Gateway only accepts this tool's tokens (and its delegated client's), the Lambda re-verifies
the token itself, and its IAM role reaches only this tool's table (writing only confirmations, the audit trail and
grants), the relay's connection, the list of `family_house` members, and reading the family's groups.
