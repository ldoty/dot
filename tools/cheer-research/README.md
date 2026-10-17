# Cheer Research

`https://cheer-research.dot-y.co/` · permission group **`lukes_research`** · progress table `family-cheer-research`

Luke’s field guide to the youth cheer and dance market, for a planned SaaS: the thesis, chapters on the
segments, Varsity, private equity, software rivals, money flows, owners, timing, distribution, risk and
revenue paths; the players and who owns them; who bills what, where, with a calculator for one gym; the
questions to ask the first client and contacts; and flashcards.

The guide is private business research, so it is **not in git**. It lives in `private/` (gitignored), is
built into `private/guide.json`, bundled into the Lambda at deploy, and served only to members (`GET /guide`).
The public page holds none of it. The research behind it (six sets of notes and the cited report) is in the
repo root’s gitignored `private/research/`.

| Where | What |
|---|---|
| `web/index.html` | The page: sign-in, progress sync, and the guide’s UI (`window.startGuide`). No data |
| `api/api.mjs` | `GET /guide`, `GET`/`PUT /progress` (one saved state per user, last write wins) |
| `scripts/build.py` | Checks `private/content.json` and writes `private/guide.json` |
| `private/content.json` | Written by hand from the report: thesis, chapters, players, flows, calculator defaults, questions, cards |
| `infra/` | OpenTofu root (state key `tools/cheer-research/terraform.tfstate`) |
| `tests/` | `*.test.mjs` run in `npm test` against an invented `guide.fixture.json`; `*.live.mjs` in `npm run test:live` |

Every point, player and flow carries an evidence label: **C** a cited source states it (often one gym or
vendor), **R** one secondary or opinion source, **E** an estimate. Cards get a stable id from their topic and
question, so editing an answer keeps your progress on it; rewording the question starts it fresh.

Progress (Leitner box per card, deck, last tab, filters, calculator inputs and which questions you’ve asked)
is kept in the browser and saved to the account a second after each change.

## The calculator

For one gym or studio a year: head counts × each flow’s low, mid or high amount gives what families spend;
the ticked flows (high-capture ones start ticked) are the payment volume. Revenue is payments (card and ACH
net take on that volume), an optional parent-paid fee, texting margin (families × texts × price − cost),
marketing and website fees, and AI outcomes (count × price). The market line multiplies by gyms × share.

## Updating the guide

Edit `private/content.json`, then:

```sh
python3 tools/cheer-research/scripts/build.py   # fails on unknown topics, kinds, roles, segments or labels
cd tools/cheer-research/infra && tofu apply     # re-bundles the guide into the Lambda
```

`private/` exists only on the machine that built it; deploying from elsewhere needs a copy of it.

## Deploy

```sh
python3 tools/cheer-research/scripts/build.py
cd tools/cheer-research/infra && tofu init && tofu apply
cd ../../../platform/core && tofu apply          # its home page tile
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_research
npm run test:live
```

Access is checked four times: Cognito won't issue a token unless the user is in `lukes_research`,
API Gateway only accepts this tool's tokens, the Lambda re-verifies the token itself, and its
IAM role can only reach this tool's table.
