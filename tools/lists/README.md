# Lists

`https://lists.dot-y.co/` · permission group **`family_lists`**

To-dos, checklists and reminders: each list yours alone until you share it, with a person or a
family group (dot-y.co/family), to see or to edit. Dot reads them and changes them as whoever asks,
and reminders come by text or email, even when the home server is down.

| Folder | What |
|---|---|
| `web/` | The page (installable: add it to your phone's home screen) |
| `api/` | `api.mjs` (the API), `model.mjs` (access, layouts, what a list, item and reminder are), `repeat.mjs` (repeating items), `sweep.mjs` (sends reminders). `verify-token.mjs`, `dot-manifest.mjs`, `people.mjs`, `twilio.mjs` link to `platform/api/` |
| `infra/` | OpenTofu root (state key `tools/lists/terraform.tfstate`); `sweep.tf` is the every-minute reminder sweep |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Access

Per list: the creator **owns** it; the owner shares it with people or family groups at **read** (see)
or **edit** (add, change, tick off; rename; switch layout). Only the owner shares or deletes. There is
no admin override: a personal list is personal. Dot works as the person asking: it can change what
they can edit, never who a list is shared with, and it deletes a list only after the person's own OK.

## Layouts

A layout is a view of the same items, so switching never loses anything: **checklist**, **matrix**
(Eisenhower: each item's urgent and important flags), **board** (each item's column).

## Routes and rows

The routes are listed at the top of `api/api.mjs`, the rows there and in `api/sweep.mjs`:
`LIST`, `ITEMS#<list>`, `REMIND#<day>` (what the sweep still has to send), `SENT#<day>` (sent, kept
3 days for "done"/"snooze" replies), `PREF` (text or email), `PENDING` (a deletion awaiting the OK).

## Reminders

`sweep.mjs` runs every minute in AWS, one at a time. It claims each due reminder (a conditional write)
before sending, so nothing goes twice; a failed send is recorded, not retried. Texts go through the
Dot-y number's registered campaign, never with links, only to a verified phone; email comes from
dot@dot-y.co. Replies reach Dot, which finds the reminder through `GET /reminders/recent` (the manifest's `sent`
role, so it's in the note Dot reads before a reply). `GET /automations` lists each person's reminders still to
come as automations (the shape every tool's share), for Dot's “Runs on its own”.

## Repeating

An item can repeat from its due date or reminder: a small part of the calendar standard's rule
format (`FREQ`, `INTERVAL`, weekly `BYDAY`, monthly `BYMONTHDAY` or `BYDAY=2TU`/`-1FR`, `UNTIL`/`COUNT`),
in the person's time zone so 9 AM stays 9 AM; the 31st falls on a short month's last day. Ticking it
off moves it to its next occurrence. Each item chooses what happens if it isn't ticked off:
**when_done** waits, overdue; **schedule** rolls on and reminds again (the sweep does that).

## Deploy

```sh
cd tools/lists/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # its home page tile
npm run build && cd tools/assistant/infra && tofu apply   # Dot's lists_change
npm run test:live
```
