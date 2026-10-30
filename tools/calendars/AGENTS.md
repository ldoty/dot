# Agent notes: Calendars

Read `README.md`. Rules:

- **Only this tool reads the Google key** (`/family/calendar/google-key`). Don't give it back to Dot or
  anything else; they call this API as a person.
- **Grants decide, then Google.** A calendar is visible only with a grant; editable only with an `edit`
  grant *and* Google sharing it with change access. No admin override on events.
- **Dot can't touch calendars or grants**, and deletes an event only after the person's own reply.
- `google-calendar.mjs` came from Dot unchanged (its tests are `tests/google.test.mjs`). Events Dot
  makes are tagged; people are noted on events, never Google attendees (a service account can't invite).
- **Invitations** (`api/invite.mjs`, `POST /events/{calendar}/{eventId}/invite`) are emails from
  invites@dot-y.co with an iCalendar REQUEST, the person as organizer, only to people noted on the event,
  only from calendars they may change, at most 30 a person a day. From Dot, always asked first (202, like a
  delete); a scheduled ask can't. They email outsiders: keep every one of those rules.
