# Links

`https://links.dot-y.co/` · permission group **`family_links`** (admins: `family_links:admin`)

Family bookmarks, grouped into sections. Links must be http(s), checked on the page and in the API.

API: `GET /all`, `PUT`/`DELETE /sections/{id}` (deleting a section deletes its links), `PUT`/`DELETE /links/{id}`.
Table rows (`pk = TOOL`): `SECTION#<id>`, `LINK#<id>`. `scripts/seed.mjs` adds the Technology section with UniFi.

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js` |
| `api/` | Lambda handler. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/links/terraform.tfstate`) |
| `scripts/` | Seeds, migrations, one-offs for this tool |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Deploy

```sh
cd tools/links/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
../scripts/invite.sh someone@example.com Name family_links   # or add existing users to the group
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `family_links`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
