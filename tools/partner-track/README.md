# Partner Track

`https://partner-track.dot-y.co/` · permission group **`lukes_partner_track`** (admins: `lukes_partner_track:admin`) · progress table `family-partner-track`

A course modeled on Tempi’s, for Luke: how to become a VC/PE investor and run a fund built on
Contribution Units. Seven modules named for financing rounds (Pre-seed to Exit), each with reading,
a quiz, a hands-on tool, a skill builder and journal questions. The tools are a $25M fund model
(gross to net), a power-law simulator (2,000 seed funds), a napkin buyout with an ownership pool, and
a prediction log with a Brier score. Beyond the modules: the plan (the company first, then the firm),
a field kit, and the collected journal.

| Where | What |
|---|---|
| `web/index.html` | The public shell: styles, sign-in, progress sync and the course’s script. No course content |
| `api/course.html` | The course itself, including its quiz items (a JSON block). Bundled into the Lambda and served only to members (`GET /course`) |
| `api/api.mjs` | `GET /course`, `GET`/`PUT /progress` (one saved state per user, last write wins) |
| `infra/` | OpenTofu root (state key `tools/partner-track/terraform.tfstate`) |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

Progress (module checkmarks, journal, quiz picks, model inputs, self-ratings, predictions) is kept in the
browser and saved to the account a second after each change.

To edit the course, change `api/course.html` (markup and quiz items) or the second script in
`web/index.html` (behavior; it runs after the course is inserted, through `window.startCourse`), then
re-apply `infra/`. Keep course text out of `web/index.html`: the tests check the public page doesn’t contain it.

## Deploy

```sh
cd tools/partner-track/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # its home page tile and the "climb" icon
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_partner_track
npm run test:live
```
