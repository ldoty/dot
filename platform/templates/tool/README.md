# __TITLE__

`https://__TOOL__.dot-y.co/` · permission group **`__GROUP__`** (admins: `__GROUP__:admin`)

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js` |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/__TOOL__/terraform.tfstate`) |
| `scripts/` | Seeds, migrations, one-offs for this tool |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Deploy

```sh
cd tools/__TOOL__/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
../scripts/invite.sh someone@example.com Name __GROUP__   # or add existing users to the group
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `__GROUP__`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
