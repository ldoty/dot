# Budget: agent notes

Read the root `AGENTS.md` first; this adds what's specific to Budget.

Docs `shared`, `Luke`, `Amber`, each with a working copy (`DOC#<doc>#STATE`, with `rev`), saved
versions (`DOC#<doc>#VERSION#<id>`) and tags (`TAG#<doc>#<name>`; `default` opens on load), plus a
`DEFAULTS` row (the starting numbers, `GET /defaults`, used by Reset). A
personal doc `follows` a Shared tag, or one Shared version directly (`@v:<id>`). The page normalizes
state on load (`normalizeShared`, `normalizePerson`): every personal doc has a fixed, locked
**Shared contributions** section (`contrib`) with `contrib-share` (`calc: share`: their share of
Shared from the split slider, less travel) and `contrib-travel` (`calc: travel`: their part of the
travel fund: Shared categories with `fund: "travel"`, else any named “travel”). `PLAN#<id>` rows (named, each with `rev`)
hold the **Planning** tab's plans: steps `{from: YYYY-MM, tag}` (a Shared tag per stretch of months), `accounts`
(balance, yearly `rate`, `paidBy` a Shared line that pays a loan down, one marked `savings`) and one-offs
(into an `account`, or moved `to` another); saved = Shared categories with `kind: "save"`. Older plans'
`balance` becomes one account on load. The page holds all
the math; the API stores JSON blobs. Dot and the finances tools read it read-only (Dot gets the plans with Shared).
