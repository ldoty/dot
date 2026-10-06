# Finances: agent notes

Read the root `AGENTS.md` first; this adds what's specific to Finances (`tools/finances` + three deployments).

One codebase; each deployment is `tools/<x>-finances/infra/main.tf` calling `../../finances/infra`
with `tool`, `group`, `title`, `tile_description`, `partition` and `owner` (whose access reads the
budget on the nightly sync). Personal deployments set `person` (Budget's doc name). Shared sets
`mode = "shared"`, `sources` (the personal tools to read, and as whom), `delegates = ["dot"]` and a
later `schedule`. Defaults: `mode = "personal"`, `delegates = ["dot", "shared_finances"]`.
- **Sync** (`api/sync.mjs`, nightly 6:30 NY; Shared at 7:00; or “Sync now”): personal pulls SimpleFIN
  (`simplefin.mjs`: claims a setup token once; 89 days the first time, then from 7 days before the
  newest stored transaction; new accounts get a one-off 89-day backfill); shared pulls each personal
  tool's `GET /shared/{from}` (from a week before its newest, or everything when `FEED` in `sync.mjs`
  is bumped because the feed's shape changed) and de-duplicates
  (accounts by bank + last 4, transactions by date + amount + description, keeping real repeats). Then:
  read the budget as the owner → matched transfers → contributions → rules → Claude (`categorize.mjs`).
- **Line ids** (filing targets): `L.<item>` personal line, `LC.<category>` a personal category's
  General line, `S.<item>` / `SC.<category>` Shared (Shared Finances only), `X.transfer` Transfers (never
  counted), `X.in.<Person>` / `X.in` money into Shared, `X.to.<account>` automatic “To <account>”
  contribution lines (only when the budget has no `contrib` section), `L.contrib-share` / `L.contrib-travel`.
  Personal tools never file to `S.`/`SC.` lines and Shared Finances never to `L.`/`LC.` (the sync clears such filings).
- **Precedence**: your hand-filing (`source: you`) > matched transfers/contributions > merchant rules
  (`RULE#<merchant>`, by you or Claude) > Claude. Claude is asked about a transaction once per budget
  version (`asked`), never about contribution lines, and only about the view's own accounts.
- **Accounts** have `owner` `mine` | `shared` | `off` (shared accounts appear only in the account list
  of a personal tool; their data is Shared Finances') and, if shared, `fund` `household` | `travel`.
- The budget a deployment follows (`SETTINGS.tag`): a tag, `@working` (live working copy) or `@v:<id>`.
  `GET /month` re-reads it (as the person signed in) when the stored copy is over 5 minutes old;
  “Refresh budget” on the page calls `PUT /settings` with the current tag to re-read it now.
- `GET /month/{month}` is the page's (and Dot's) one read: summary, 3-month trend, transactions,
  accounts, sync status. A transaction can count in the month before or after it posted (`month`).
- **Never change the description of the `simplefin` SSM parameter** (also in the root guide).
