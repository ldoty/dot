# Budget

`https://budget.dot-y.co/` · permission group **`family_budget`** · table `family-budget`

Luke & Amber's household budget: a Shared budget plus one per person, each with its own working
copy and saved versions. Tags (`default`, …) name saved Shared versions; each personal tab follows
a tag, and its share of costs comes from that version, so editing Shared doesn't move anyone's
numbers until a version is saved and tagged.

| Folder | What |
|---|---|
| `web/index.html` | The page. Holds no data; everything loads from the API after sign-in |
| `api/api.mjs` | Lambda: `GET /all`, `GET /defaults`, `PUT /docs/{doc}/state`, versions, tags |
| `infra/` | OpenTofu root (state key `tools/budget/terraform.tfstate`) |
| `scripts/seed.mjs` | Loads starting numbers / migrates / imports a browser export |
| `tests/` | API tests, page tests (page → real handler → in-memory table), live checks |

Table rows (`pk = HOUSEHOLD#luke-amber`): `DOC#<doc>#STATE` (with `rev` for conflict checks),
`DOC#<doc>#VERSION#<id>`, `TAG#<name>`, `DEFAULTS` (Reset target), and `STATE`, the pre-split
combined budget kept as a backup.

The original single-file page and its real starting numbers live in `private/project_pax/`
(gitignored); `scripts/seed.mjs` reads them from there.
