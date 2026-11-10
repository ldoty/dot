# Trip planner

`https://trip-planner.dot-y.co/` · permission group **`lukes_trip_planner`** (admins: `lukes_trip_planner:admin`)

Luke's trips. The page opens on a month calendar: each trip is a bar across its days, and clicking a
day (or **Book a trip**) books one: name, type (backpacking for now), where, dates, and a packing list
that starts empty or as a copy of another trip's (same categories and items, every mark cleared).
A trip (`#/trip/<id>`) holds its details, free-text **notes** and **itinerary**, and its **packing list**:
the box beside each item takes a letter: **v** puts it on the verify list, **b** on the shopping list,
**c** on the check list, **x** marks it packed. Text edits in place; drag ⠿ to reorder.

It began as the packing list at packing.dot-y.co (`scripts/from-packing.mjs` moved that list in as
the Jones Gap trip).

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js`; saves a moment after each change, and before leaving a trip |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/trip-planner/terraform.tfstate`) |
| `scripts/` | `from-packing.mjs`: the one-off move from the old packing list |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Rows

One row per trip, `pk = TOOL`, `sk = TRIP#<id>`: `{ id, name, type, where, start, end, notes, itinerary,
categories, items, rev, updatedAt, updatedBy }`. The page saves the whole trip with its `rev`; if another
device saved first the API answers 409 with the current trip and the page shows that one. A new trip
type is one entry in `TYPES` in `api/api.mjs` and in the page.

## Deploy

```sh
cd tools/trip-planner/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> --username <sub> --group-name lukes_trip_planner
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `lukes_trip_planner`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
