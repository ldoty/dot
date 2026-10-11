# Chamber

`https://chamber.dot-y.co/` · permission group **`lukes_chamber`** (admins: `lukes_chamber:admin`)

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js` |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/chamber/terraform.tfstate`) |
| `scripts/` | Seeds, migrations, one-offs for this tool |
| `firmware/` | Arduino sketches: `chamber_telemetry/` (the controller) and `bench/` (one-off tests). See `AGENTS.md` |
| `BUILD.md`, `SHOPPING.md` | Hardware build log, design decisions, parts |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Deploy

```sh
cd tools/chamber/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
../scripts/invite.sh someone@example.com Name lukes_chamber   # or add existing users to the group
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `lukes_chamber`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
