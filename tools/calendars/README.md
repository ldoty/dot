# Calendars

`https://calendars.dot-y.co/` · permission group **`family_calendars`** (admins: `family_calendars:admin`)

The family's Google calendars, and who may see or change each. The page shows your next 7 days;
admins add calendars and grant access. Dot reaches calendars only through this tool, as the person
asking, so the same grants apply.

| Folder | What |
|---|---|
| `web/` | The page: the week ahead; for admins, Calendars & access |
| `api/` | `api.mjs` (the API), `google-calendar.mjs` (Google Calendar: events, colors, people noted on events, read-only enforcement), `google.mjs` (signing in as the service account). `verify-token.mjs`, `people.mjs` link to `platform/api/` |
| `infra/` | OpenTofu root (state key `tools/calendars/terraform.tfstate`) |
| `scripts/` | `migrate-from-dot.mjs`: the one-off move of Dot's own calendar settings into this tool (2026-10-19) |

## Access

Admins add a calendar by a short name and its Google Calendar ID (or embed link). It's checked live:
it must already be shared in Google with `calendar-manager@home-host-510501.iam.gserviceaccount.com`,
and Google's answer (read-only or can change) is kept. Grants give a person or family group **read**
or **edit** on one calendar or every one; the highest wins; no grant, no calendar. A calendar Google
shares read-only stays read-only whatever a grant says. Admins see events only where granted, too.

Dot's calendar tools (`tools/assistant/api/calendars.mjs`) call this API with a delegated token. It
may read and change events within the person's grants; deleting an event needs the person's own
reply (202 + confirm_id here; Dot's `confirm.mjs`); it can never touch calendars or grants.

## Rows

`CAL` / alias `{ googleId, name, role }`, `GRANT` / id `{ who, calendar | '*', level }`, `PENDING` / id (an
event deletion awaiting the person's OK, 2 minutes).

## Deploy

```sh
cd tools/calendars/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # its home page tile
npm run build && cd tools/assistant/infra && tofu apply
npm run test:live
```
