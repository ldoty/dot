# Cards

Cards is a flashcard tool at cards.dot-y.co, for `lukes_cards` (Luke). It holds decks of cards and uses
spaced repetition to decide when each card comes back.

| Kind | Fields | Studied as |
|---|---|---|
| `basic` | front, back, notes | `forward` (front → back), plus `reverse` if asked |
| `word` | word, definition, example, part of speech, notes | `meaning` (word → what it means), `recall` (meaning → type the word), `spell` (hear it → type it) |

Each way of studying a card has its own schedule (`api/schedule.mjs`, SM-2):
- **Again:** back in 10 minutes.
- **Good:** back in 1 day, then 3, then the last interval times the card's ease.
- **Hard** and **Easy:** nudge both the interval and the ease.
- **New cards:** at most 20 are introduced a day, across all decks.

On the page, a study session can have a length, and each card can have a countdown. When the countdown
runs out, the answer shows and Again is suggested. Missed cards come round once more before the session
ends. Typed answers (recall, spell) are checked ignoring case and surrounding spaces. Spell mode speaks
the word using the browser's built-in speech. The example sentence is shown with the word blanked out.
Keys: Enter or Space to show or check, 1–4 to grade, Enter for the suggested grade.

Dot and Claude Code (through the dot-y MCP) can read decks, cards and the summary, make decks, and add
cards (`cards_card_add`: "add sesquipedalian to my words"). Nothing else: they can't edit, delete,
import or grade. These writes only add, so nothing asks first.

## Rows

| pk / sk | What |
|---|---|
| `DECK` / `<id>` | name, kind, rev, createdAt, createdVia |
| `CARD#<deck>` / `<id>` | the card's fields, modes, `sched: { <mode>: { due, interval, ease, reps, lapses, seen } }`, rev, createdAt, createdVia |
| `STAT` / `<local date>` | that day's reviews, misses and time, for the streak |

## Deploy

```sh
cd tools/cards/infra && tofu init && tofu plan && tofu apply
cd ../../../platform/core && tofu apply     # the tile (and its icon) on the home page
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_cards
npm run test:live
```
