# Budget

`https://budget.dot-y.co/` · permission group **`family_budget`** · table `family-budget`

Luke & Amber's household budget: a Shared budget plus one per person, each with its own working
copy and saved versions. Tags (`default`, …) name saved Shared versions; each personal tab follows
a tag, and its share of costs comes from that version, so editing Shared doesn't move anyone's
numbers until a version is saved and tagged.

| Folder | What |
|---|---|
| `web/index.html` | The page. Holds no data; everything loads from the API after sign-in |
| `api/api.mjs` | Lambda: `GET /all`, `GET /defaults`, `PUT /docs/{doc}/state`, versions, tags, plans |
| `infra/` | OpenTofu root (state key `tools/budget/terraform.tfstate`) |
| `scripts/seed.mjs` | Loads starting numbers / migrates / imports a browser export |
| `tests/` | API tests, page tests (page → real handler → in-memory table), live checks |

Table rows (`pk = HOUSEHOLD#luke-amber`): `DOC#<doc>#STATE` (with `rev` for conflict checks),
`DOC#<doc>#VERSION#<id>`, `TAG#<name>`, `DEFAULTS` (Reset target), `PLAN#<id>` (a named plan on the
Planning tab, with `rev`), and `STATE`, the pre-split combined budget kept as a backup.

**Planning** (`PUT`/`DELETE /plans/{id}`): named plans, each a timeline of the months ahead. Each step says which Shared tag applies
from a month on (the plan follows the tag when it moves); one-off amounts land in their month. A
month's *saved* amount is its version's Shared categories marked Savings; everything else, mortgage
included, is spending. Money sits in the plan's accounts (balance, negative for a loan, and a yearly
rate compounded monthly): savings land in one, one-offs land in or move between them, and a loan can
be paid down by a Shared line (its payment isn't counted twice). The running total is the accounts
added up. Comparing draws
another plan's running total over this one's and says how much more or less you'd pay in. Dot reads
the plans with the Shared budget (`read_budget`).

The original single-file page and its real starting numbers live in `private/project_pax/`
(gitignored); `scripts/seed.mjs` reads them from there.
