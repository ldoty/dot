# Agent notes: Lists

Read `README.md` for the pieces. Rules:

- **Lists are private until shared.** No admin override; don't add one without asking Luke.
- **Dot never changes sharing** (the API refuses it from a via-Dot token) and **deletes a list only
  after the person's own reply** (202 + confirm_id here; Dot's `confirm.mjs` holds the id until then).
- **Every text goes through the registered campaign**: no links, "Dot-y" first, only to a verified
  phone. Change the wording only if it still matches what the campaign says it sends.
- **Every reminder counts toward the person's daily limit** on what Dot-y sends unasked (`send-limit.mjs`,
  50 a day across all tools); past it, the sweep records it as not sent.
- **A reminder is never sent twice.** The sweep claims (rev-conditional write) before sending and
  never retries a failure. Keep `reserved_concurrent_executions = 1`.
- Items are written whole with their `rev`; partial updates read, merge and write (Dot's `lists.mjs`).
- **Repeats are local time.** `repeat.mjs` computes on calendar days in the item's own `tz`; never
  add a fixed number of hours. Ticking off always advances (API); only schedule mode advances unticked
  (sweep). Both use `advance()`, so the page, Dot and a "done" reply behave the same.
- The API keeps `REMIND#` rows in step with items; the sweep still checks each item before sending,
  so a leftover row is harmless.
