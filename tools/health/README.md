# Health

`https://health.dot-y.co/` · permission group **`family_health`** (admins: `family_health:admin`)

Each person's own health log: exercises, saved workouts, a plan, sessions logged set by set, body
weight, how sore spots felt after each session, a daily journal, and what they ate. Nobody sees anyone else's.
(It was Gym, at gym.dot-y.co, until 2026-10-26.)

- **Today**: this week (planned days, days trained), the next workout in the plan's rotation, a start
  button for each saved workout, body weight, today's journal, and today's food (a one-line quick add). A started session stays here until it's finished
  or deleted.
- **A session**: each exercise starts with last time's numbers and says what they were; tick a
  set and the rest timer runs (the workout item's rest; a pair's first exercise rests 15 s, the walk to the second).
  It saves as you type. With no signal it keeps the session on the phone (`localStorage`
  `health-draft`) and saves it on the next load, unless it was saved elsewhere since. At the end, rate each area
  (Settings; the starter sets Shoulders and Lower back) 0–10 and add notes.
- **Journal**: a few words a day on how you feel physically (`PUT /journal/{date}`, rev-checked, saved as you type);
  past days listed below, any day opens to edit.
- **Food**: what you ate, by day: what it was, meal, time, and calories and protein if you know them
  (`PUT /food/{id}`, rev-checked), with the day's totals. Tap an entry to fix or delete it. Or text Dot a photo of it.
- **History**: finished sessions; opening one lets you fix it.
- **Progress**: sessions per week against the goal, one exercise's best per session (top weight if
  you log weight, else reps, seconds, meters or breaths), each area's rating, body weight.
- **Plan**: the rotation, training days, a weekly goal, optional from/until. **Settings**: lb or kg, areas to rate.
- **Holds** (stretches, planks, hangs) are counted in breaths, not seconds: an exercise's `measure` is `breaths`
  and each set's count is `b`. `time` (seconds) is still there for things you time.
- **Starter program** (`api/starter.mjs`, `POST /starter`, only into an account with no exercises or
  workouts): Sessions A and B (full body, kind to shoulders and the lower back), a 10-minute Mobility routine, Mon/Wed/Fri alternating A and B.

API and rows are listed at the top of `api/api.mjs`; what Dot sees is in `api/dot.mjs`. Rows are keyed `pk = P#<username>`, so a
person's token only ever reaches their own rows. Everything but body weight is `rev`-checked (409 with the current row).

| Folder | What |
|---|---|
| `web/` | The page. Plain HTML, signs in with `family-auth.js` |
| `api/` | Lambda handler and the starter program. `verify-token.mjs` links to `platform/api/` and is bundled at deploy |
| `infra/` | OpenTofu root (state key `tools/health/terraform.tfstate`) |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

## Deploy

```sh
cd tools/health/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> --username <sub> --group-name family_health
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `family_health`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.

## Dot

Health has a delegated client (`delegated = true`, published at `/family/delegation/family_health`), so Dot
can use it for whoever is asking, by chat, text or email, and only ever sees that person's log
(`api/dot.mjs`). It can read the summary (this week, what's next, recent sessions,
soreness, the last few journal days, today's food), sessions, one exercise's history, the journal, food by day and the saved workouts and plan. It can also add things:
log a session someone describes (`POST /dot/log`, names matched to their own workout and exercises),
log a body weight, log food (`POST /dot/food`: send it a photo of a meal and it says what it is, estimates calories
and protein and logs it, marked as Dot's estimate until you edit it; the photo stays with Dot, deleted after 7 days),
and add to a day's journal (`POST /dot/journal`: a new paragraph after what's there, never a rewrite). Additions don't need a confirmation step. Every other write refuses a via-Dot token (403 `read-only`), so
Dot never changes or deletes what's logged. "Today" for Dot is the day in `TZ_HOME` (America/New_York).

Not yet: reminders, calendar events.
