# Packing

`https://packing.dot-y.co/` · permission group **`lukes_packing`** (admins: `lukes_packing:admin`)

Luke's backpacking gear list, moved here from a local Python server so it works from any device.
Items sit in categories; the box beside each takes a letter: **b** puts it on the shopping list,
**c** on the check list, **x** marks it packed. Text edits in place; drag ⠿ to reorder items and categories.

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js`; saves a moment after each change |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/packing/terraform.tfstate`) |
| `scripts/` | `seed.mjs`: loads `private/packing_list.json` (gitignored) into the table if it's empty |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Rows

One row, `pk = TOOL`, `sk = LIST#main`: `{ categories, items, rev, updatedAt, updatedBy }`. The page
saves the whole list with its `rev`; if another device saved first the API answers 409 with the
current list and the page shows that one (the losing edit is the last quarter-second's typing).

## Deploy

```sh
cd tools/packing/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> --username <sub> --group-name lukes_packing
node tools/packing/scripts/seed.mjs              # once
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `lukes_packing`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
