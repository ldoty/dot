# Two Boards

`https://boards.dot-y.co/` · permission group **`lukes_boards`** (admins: `lukes_boards:admin`) · progress table `family-boards`

Luke’s field guide for joining the NextGEN and Artisphere boards: everyone on both boards and staffs,
where the two overlap, the plan, and flashcards (faces, roles, facts, which org, bridges, and a
Partner Track deck that tags people as co-investors, future LPs, deal flow, health care or exited founders).

The guide is research on real people, compiled from public sources, so it is **not in git**. It lives in
`private/` (gitignored), is built into `private/guide.json`, bundled into the Lambda at deploy, and served
only to members (`GET /guide`). The public page holds no names.

| Where | What |
|---|---|
| `web/index.html` | The page: sign-in, progress sync, and the guide’s UI (`window.startGuide`). No data |
| `api/api.mjs` | `GET /guide`, `GET`/`PUT /progress` (one saved state per user, last write wins) |
| `scripts/build.py` | `private/research` + `private/curated.json` + `private/photos` → `private/guide.json` |
| `private/research/` | `people-*.json` (arrays of people) and `orgs.json`, as researched |
| `private/curated.json` | Decided by hand: bridges, overlaps, sponsors, the Partner Track lens, the plan |
| `private/photos/<id>.jpg` | Headshots, 320px, from the organizations’ and employers’ own sites |
| `infra/` | OpenTofu root (state key `tools/boards/terraform.tfstate`) |
| `tests/` | `*.test.mjs` run in `npm test` against an invented `guide.fixture.json`; `*.live.mjs` in `npm run test:live` |

Progress (Leitner box per card, deck settings, last tab and filters) is kept in the browser and saved
to the account a second after each change.

## Updating the guide

Edit `private/curated.json` or the research files, add photos as `private/photos/<id>.jpg` (the id is
the name lowercased and hyphenated, middle initials dropped), then:

```sh
python3 tools/boards/scripts/build.py      # fails if curated.json names someone not in the research
cd tools/boards/infra && tofu apply        # re-bundles the guide into the Lambda
```

`private/` exists only on the machine that built it; deploying from elsewhere needs a copy of it.

## Deploy

```sh
python3 tools/boards/scripts/build.py
cd tools/boards/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # its home page tile and the "venn" icon
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_boards
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `lukes_boards`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
