# Agent notes: Lists

Read `README.md` for the pieces. Rules:

- **Lists are private until shared.** No admin override; don't add one without asking Luke.
- **Dot never changes sharing** (the API refuses it from a via-Dot token) and **deletes a list only
  after the person's own reply** (202 + confirm_id here; Dot's `confirm.mjs` holds the id until then).
- **Every text goes through the registered campaign**: no links, "Dot-y" first, only to a verified
  phone. Change the wording only if it still matches what the campaign says it sends.
- **A reminder is never sent twice.** The sweep claims (rev-conditional write) before sending and
  never retries a failure. Keep `reserved_concurrent_executions = 1`.
- Items are written whole with their `rev`; partial updates read, merge and write (Dot's `lists.mjs`).
- The API keeps `REMIND#` rows in step with items; the sweep still checks each item before sending,
  so a leftover row is harmless.
