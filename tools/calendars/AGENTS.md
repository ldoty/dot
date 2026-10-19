# Agent notes: Calendars

Read `README.md`. Rules:

- **Only this tool reads the Google key** (`/family/calendar/google-key`). Don't give it back to Dot or
  anything else; they call this API as a person.
- **Grants decide, then Google.** A calendar is visible only with a grant; editable only with an `edit`
  grant *and* Google sharing it with change access. No admin override on events.
- **Dot can't touch calendars or grants**, and deletes an event only after the person's own reply.
- `google-calendar.mjs` came from Dot unchanged (its tests are `tests/google.test.mjs`). Events Dot
  makes are tagged; people are noted on events, never invited (a service account can't invite).
