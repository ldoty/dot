# Tempi's OT Course

`https://tempi.dot-y.co/` · permission group **`family_tempi`** (admins: `family_tempi:admin`) · progress table `family-tempi`

An exploratory course in pediatric occupational therapy: six modules, hands-on activities, a journal,
and an email draft for reaching out to a working OT. Moved here from a standalone HTML file.

| Where | What |
|---|---|
| `web/index.html` | The public shell: styles, sign-in, progress sync and the course's script. No course content |
| `api/course.html` | The course itself. Bundled into the Lambda and served only to members (`GET /course`) |
| `api/api.mjs` | `GET /course`, `GET`/`PUT /progress` (one saved state per user, last write wins) |
| `infra/` | OpenTofu root (state key `tools/tempi/terraform.tfstate`) |
| `tests/` | `*.test.mjs` run in `npm test`; `*.live.mjs` run in `npm run test:live` |

Progress (module checkmarks, journal entries, sliders, quiz picks) is kept in the browser and saved to
the account a second after each change, so every device picks up where you left off.

To edit the course, change `api/course.html` (markup) or the second script in `web/index.html`
(behavior; it runs after the course is inserted, through `window.startCourse`), then re-apply `infra/`.

## Deploy

```sh
cd tools/tempi/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # picks up this tool's home page tile
../scripts/invite.sh someone@example.com Name family_tempi   # or add existing users to the group
npm run test:live
```
