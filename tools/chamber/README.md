# Chamber

`https://chamber.dot-y.co/` · permission group **`lukes_chamber`** (Luke only)

The mushroom fruiting chamber. An Arduino UNO R4 WiFi runs the climate on its own (humidity,
fresh air, light) and posts a reading every ~10 s to this tool, which stores it and shows it,
and hands the board any settings changed on the page. **Control never depends on this tool:**
if AWS or the network is down the chamber keeps running on its last settings, and readings
from that time are lost.

| Folder | What |
|---|---|
| `web/` | The page: live tiles, stacked charts on one time axis, the settings panel, CSV download |
| `api/` | `api.mjs` (the page's API, signed in), `ingest.mjs` (the board's endpoint, device key), `settings.mjs` (shared spec and checks). `verify-token.mjs` links to `platform/api/` |
| `infra/` | OpenTofu root (state key `tools/chamber/terraform.tfstate`); `ingest.tf` is the board's route |
| `firmware/` | Arduino sketches: `chamber_telemetry/` (the controller) and `bench/` (one-off tests). See `AGENTS.md` |
| `BUILD.md`, `SHOPPING.md` | Hardware build log, design decisions, parts |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Routes

| Route | Who | What |
|---|---|---|
| `POST /ingest` | The board, with `x-chamber-key` | Store a reading; reply `time=` (local seconds since midnight) and `cfg=` (desired settings) |
| `GET /readings?since=&fields=` | Signed in | Readings after `since` (≤ 3 days), as `{ now, fields, rows }` |
| `GET /readings.csv?since=` | Signed in | Every field, ≤ the last 24 h |
| `GET /settings`, `PUT /settings` | Signed in | Desired settings, what the board runs, and saving a change |

## Table `family-chamber`

| pk | sk | What |
|---|---|---|
| `R#<UTC day>` | ISO time | One reading, stamped on receipt; `expires` a year out (TTL) |
| `STATE` | `LATEST` | The newest reading (for alerts / Dot, later) |
| `STATE` | `DESIRED` | Settings saved on the page: `version`, `values`, `rev` |
| `STATE` | `ACTIVE` | The board's last `chamber_cfg`: what it really runs, and any version it refused |
| `STATE` | `REFILL` | Refills counted on the page (`POST /refill`): `id`, `rev`, who and when. The ingest reply hands the board `refill=<id>`; build 15+ resets its water count when it rises |
| `SETLOG` | `<ISO>#<event>#<version>` | Settings history: saved, board applied, board defaults, board rejected, refilled |

## Settings handshake

The page saves a desired version; the board gets it in its next ingest reply, checks every
value again itself (all or nothing), and reports what it runs in a `chamber_cfg` line. A saved
version is always above anything the board has applied *or refused*, because the board ignores
a version it has already seen. The bounds in `api/settings.mjs` mirror `applySettings()` in the
firmware: change both together.

## Deploy

```sh
cd tools/chamber/infra && tofu init && tofu apply
aws ssm put-parameter --profile ldoty --type SecureString \
  --name /family/chamber/device-key --value "$(openssl rand -hex 32)"   # once; same value in arduino_secrets.h
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_chamber
npm run test:live
```

Access for people is checked four times: Cognito won't issue a token unless the user is in
`lukes_chamber`, API Gateway only accepts this tool's tokens, the Lambda re-verifies the token
itself, and its IAM role can only reach this tool's table. The board's route has no authorizer;
the ingest Lambda checks the device key, its role can only read that key and write readings,
and the route is throttled to 1 request/s.
