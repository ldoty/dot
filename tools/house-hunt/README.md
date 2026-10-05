# House Hunt

`https://house-hunt.dot-y.co/` · permission group **`family_house_hunt`** (admins: `family_house_hunt:admin`)

Greer neighborhoods we're weighing, on a map: our ranked shortlist, to explore, and no-go, each with
price, pool, schools, visits, details, drive times and notes, plus one shared notes box. Every write
carries the `rev` it was edited from; if someone else saved in between it's refused (409) and the
page shows their version next to yours, so nobody's notes are silently overwritten.

Neighborhoods and listings are ranked by dragging (SortableJS, `web/sortable/`, touch included) or with
the menus and ↑ ↓ buttons. Each neighborhood has its own ranked listings; unmatched ones wait in the inbox.

API: `GET /all`, `PUT`/`DELETE /hoods/{id}` (deleting one moves its listings to unsorted), `PUT /notes`,
`PUT`/`DELETE /listings/{id}`.
Table rows (`pk = TOOL`): `HOOD#<id>`, `LISTING#<id>`, `PLACE#<id>` (map reference points, read-only in
the app), `MAIL#<time>#<messageId>` (what the ingest did with each email), `NOTES`.

## Listings by email

Listing alerts sent or forwarded to **househunt@dot-y.co** are filed automatically (`infra/mail.tf`,
`api/ingest.mjs`). SES stores each message in this tool's mail bucket (kept 90 days) and invokes the ingest
Lambda, which takes mail only from `allowed_senders` (your Gmail addresses and the big listing sites) and
only when it passes DMARC. Claude on Bedrock (`var.model`) reads the email as untrusted data and returns
the homes in a fixed schema, each matched to one of our neighborhood ids or none. A home we already have
(same street address) gets its price, status and history updated; our notes, rank and neighborhood stay.
New homes go to the bottom of their neighborhood's list, or the inbox. The ingest is bundled with
`npm run build` (it uses `mailparser` and the Bedrock SDK).

`scripts/hoods.mjs` is the starting data: the Greer Trail Neighborhoods map (2026-09-27) merged with the
pool + Riverside High price research (2026-10-04). `scripts/seed.mjs` loads it, plus personal places
(family, the gym) from the git-ignored `private/house-hunt-places.json`. Re-running only refreshes rows
nobody has edited; edited rows just get empty fields filled.

The map is Leaflet 1.9.4 (`web/leaflet/`, served from this site) over OpenStreetMap tiles.

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js` |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/house-hunt/terraform.tfstate`) |
| `scripts/` | Seeds, migrations, one-offs for this tool |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Deploy

```sh
npm run build                                    # bundles the email ingest
cd tools/house-hunt/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
node tools/house-hunt/scripts/seed.mjs           # from the repo root; safe to re-run
../scripts/invite.sh someone@example.com Name family_house_hunt   # or add existing users to the group
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `family_house_hunt`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
