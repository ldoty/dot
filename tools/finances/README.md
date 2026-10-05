# Finances (the shared code)

One codebase, three deployments, each its own root, state, table and permission group:

| Deployment | Site | Group | Mode |
|---|---|---|---|
| `tools/luke-finances` | luke-finances.dot-y.co | `luke_finances` (Luke) | personal: Luke’s SimpleFIN, Luke’s budget |
| `tools/amber-finances` | amber-finances.dot-y.co | `amber_finances` (Amber) | personal: Amber’s SimpleFIN, Amber’s budget |
| `tools/shared-finances` | shared-finances.dot-y.co | `shared_finances` (both) | shared: the accounts marked shared in either, against the Shared budget |

`infra/` is the module each deployment calls; `api/`, `web/` and `tests/` are shared. Each
deployment's signer (`luke_finances`, `amber_finances`, `shared_finances`) is in core's
`delegation_signers`, limited to the people it may act for.

**Shared Finances** reads each personal tool’s shared accounts as their owner (`GET /shared/{from}`,
read-only, via its own signer), merges accounts that are the same joint account in both feeds
(bank + last 4: “Shared (7892)” and “PREMIER PLUS CKG (7892)” are one), and de-duplicates their
transactions by date + amount + description, keeping real repeats. It syncs at 7:00, after the
personal tools (6:30). Marking an account shared happens in the personal tools.


**Personal mode:** a person’s bank and card transactions from their own [SimpleFIN Bridge](https://bridge.simplefin.org)
connection, filed under the lines of their budget, with how each line is tracking this month (MTD against an even pace).

- **Sync** (nightly at 6:30 New York time, or “Sync now”): pulls accounts and posted transactions
  (90 days the first time), reads the budget, and files new transactions: Luke’s own corrections
  first (“same merchant from now on”), then Claude on Bedrock, else left to file by hand.
- **Budget**: finance follows one of Luke’s budget tags (default `default`). That version names the
  Shared tag it follows, so the lines are Luke’s own plus his part of each Shared item.
  It reads Budget **as Luke, read-only**, the way Dot does: a short-lived token from Budget’s
  delegated client, signed with this tool’s own KMS key. Core (`delegation_signers`) lets that key
  act only for Luke, and Budget lists `luke_finances` in its `delegates`. Every read is audited.
- **Transfers**: the same amount out of one account and into another within 4 days is a transfer,
  filed under Transfers and never counted in a budget. Matched before rules and Claude, never over
  your own filing. Money from your account into a shared one is your contribution (your side is
  filed like spending); only the shared side is a transfer.
- **Accounts**: each is Mine, Shared (a joint account: its transactions only go under Shared lines
  or Transfers) or Off (not counted). Shared lines count the household’s amount, whoever paid.
- **Months**: a transaction can count in the month before or after it posted (“Counts in”), e.g.
  September 26th’s child support against October. Totals, trend and CSV use that month.
- **Live budget**: the page re-reads the budget when its copy is over 5 minutes old. Follow
  “Working copy (live)” to see Budget edits without saving a version or moving a tag.
- **CSV**: “Download CSV” on the page, a month or everything.

| Folder | What |
|---|---|
| `web/` | The page. `#2026-10` opens a month |
| `api/index.mjs` | Lambda entry points: `index.api` (API Gateway) and `index.sync` (schedule); `MODE` personal or shared |
| `api/api.mjs` | Routes: month summary, filing, accounts, settings, sync now, CSV |
| `api/sync.mjs` | The sync, and reading the budget as Luke |
| `api/simplefin.mjs` | Claims a setup token; fetches accounts (credentials in a header, not the URL) |
| `api/budget-lines.mjs` | Budget → lines, mirroring the budget page’s math |
| `api/categorize.mjs`, `api/summary.mjs` | Filing rules + Claude; month-to-date math |
| `api/transfers.mjs` | Matching the two sides of a transfer |
| `infra/` | OpenTofu root (state key `tools/luke-finances/terraform.tfstate`) |
| `tests/` | Unit, API and page tests (fake SimpleFIN, Budget and Claude; in-memory table); live checks |

## Adding a deployment

```sh
# 1. platform/core/auth.tf delegation_signers: <group> = { users = [<who it may act for>] }; tofu apply
# 2. tools/budget/infra/main.tf delegates: add <group>; tofu apply
# 3. tools/<tool>/infra: versions.tf (state key) + main.tf calling ../../finances/infra
npm run build && cd tools/<tool>/infra && tofu init && tofu apply
# 4. re-apply platform/core for the home page tile; add people to <group>
```

A personal deployment then needs its SimpleFIN **setup token** pasted over the placeholder in SSM
`/family/<tool>/simplefin`; the first sync claims it and stores the access URL in its place.

## Notes

- Pending transactions are skipped (their ids change when they post), so the newest day or two
  may be missing until the bank posts them.
- Paying a card from checking shows up twice (the purchases, then the payment): file the payment
  under “Transfer between my accounts / card payment”, which isn’t counted.
- Yearly items count at 1/12 a month, so a once-a-year bill shows as over in the month it’s paid.
