# Go

`https://go.dot-y.co/` · permission group **`lukes_go`** (Luke)

Drills made from Luke's own 9x9 games on OGS. KataGo looks at every move, the moves that lost points
are sorted by the kind of mistake, and each kind becomes something to drill until it's gone. Spaced
repetition (`platform/api/schedule.mjs`, the same SM-2 as Cards) decides when each position comes back.

| Drill | What | Source |
|---|---|---|
| `fix` | Find a better move than the one played. Its theme is the kind of mistake | His mistakes, and his opponents' (players at his level) |
| `threat` | The opponent just played: where's the threat? | Positions where answering locally was urgent |
| `count` | Who's ahead, and by how much (komi included)? Graded against KataGo's score | Quiet middle-game positions |
| `tsumego` | Life and death, following the problem's tree | OGS puzzle collections |

Kinds of mistake (`scripts/classify.mjs`, a move that lost 3+ points gets the first that fits):
ignored a threat, let stones die, missed a kill, answered when he could tenuki (gote), missed the key
point (the point touching both colours elsewhere), endgame order, played in the wrong area, right area
but the wrong move. KataGo only gives scores, best moves and ownership; the kinds come from those plus
the board.

## Building the drills (on the Mac, not in AWS)

```sh
brew install katago                                   # comes with the b18 network
node tools/go/scripts/analyze.mjs --games 200         # OGS games (cached, 1 request/s) -> KataGo -> private/analysis/
node tools/go/scripts/classify.mjs                    # -> private/bank.json, prints his mistakes by kind
node tools/go/scripts/fetch-tsumego.mjs               # -> private/tsumego.json
node tools/go/scripts/upload.mjs                      # new drills into family-go; existing ones (and their schedules) kept
```

Everything fetched or computed stays in gitignored `private/`. The page never calls OGS or KataGo.

## Rows

| pk / sk | What |
|---|---|
| `DRILL#<kind>` / `<id>` | the position (`stones`: 81 digits, 0 empty 1 black 2 white), `toMove`, `last`, the answers, `theme`, `mine`, `sched`, `rev` |
| `STAT` / `<local date>` | that day's drills and misses, by kind and theme, and counting error |
| `PROFILE` / `mistakes` | the error database: his mistakes by kind (count, points lost) and how many games |

## Deploy

```sh
cd tools/go/infra && tofu init && tofu plan && tofu apply
cd ../../../platform/core && tofu apply     # the tile (and its icon) on the home page
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_go
node tools/go/scripts/upload.mjs
npm run test:live
```
