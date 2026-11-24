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

## The training program (`api/plan.mjs`)

One focus at a time, in the order his mistakes cost him in real games (from the error database), each with
one rule to play by. A session a day, about 20 minutes: a life-and-death warm-up at his level (the level
moves up when warm-ups are 90% right over three days, down under 70%), up to 12 focus drills (his own
positions first), 3 counting positions, and up to 10 other drills that are due. What's done today comes off.
After a week, 40 focus drills and 85% right, the page suggests moving on; he decides (skipping early asks
first). The real test is the chart of his real games week by week (`WEEK` rows): points lost a game, for the
focus and overall, with the week training started marked.

## Is it working? (the experiment)

Training started **2026-11-24**. The baseline is every 9x9 game analysed up to then (198 games,
2026-09-25 to 2026-11-24), recorded in gitignored `private/baseline.json`, with the numbers written up in
`private/BASELINE.md` (real data stays out of git). To check:

```sh
node tools/go/scripts/weekly.mjs      # bring in the newest games
node tools/go/scripts/progress.mjs    # games since the baseline, against it, kind by kind
```

What counts:
- **How often each mistake happens a game** is the measure. Points lost a game follow it but are noisy (one
  dead group is 40 points), so a points change alone is weaker evidence.
- A change is **real** only past twice its standard error, on 10+ games (`progress.mjs` says which). At
  ~20 games a week, two weeks only shows a big change: losing stones would have to fall from about 1.1 a
  game to about 0.55, all mistakes from about 5.1 to about 4.0. A month (~80 games) can show a smaller
  change: stones under about 0.65, all under about 4.3.
- **The focus should move first**: stones lost, the first focus, should drop before the others do. Kinds
  not yet trained are the control: if everything moves together, it's more likely form than the drills.
- **OGS rank** is the other measure (printed by `progress.mjs`). Win rate isn't: OGS pairs him with
  players his own rank, so it stays near half as the rank climbs.

## Building the drills (on the Mac, not in AWS)

```sh
brew install katago                                   # comes with the b18 network
node tools/go/scripts/analyze.mjs --games 200         # OGS games (cached, 1 request/s) -> KataGo -> private/analysis/
node tools/go/scripts/classify.mjs                    # -> private/bank.json, prints his mistakes by kind
node tools/go/scripts/fetch-tsumego.mjs               # -> private/tsumego.json
node tools/go/scripts/lines.mjs                       # KataGo's lines to step through, cached per game
node tools/go/scripts/upload.mjs                      # new drills into family-go; existing ones keep their schedules
```

Each week: `node tools/go/scripts/weekly.mjs` does all of it for his newest games (only new ones are analysed).

Everything fetched or computed stays in gitignored `private/`. The page never calls OGS or KataGo.

## Rows

| pk / sk | What |
|---|---|
| `DRILL#<kind>` / `<id>` | the position (`stones`: 81 digits, 0 empty 1 black 2 white), `toMove`, `last`, the answers, `theme`, `mine`, `sched`, `rev` |
| `STAT` / `<local date>` | that day's drills and misses, by kind and theme, and counting error |
| `PROFILE` / `mistakes` | the error database: his mistakes by kind (count, points lost) and how many games |
| `WEEK` / `<monday>` | his real games that week: games, moves, mistakes by kind |
| `PLAN` / `current` | the program: focus order, current focus and when it started, life-and-death level, history |

## Deploy

```sh
cd tools/go/infra && tofu init && tofu plan && tofu apply
cd ../../../platform/core && tofu apply     # the tile (and its icon) on the home page
aws cognito-idp admin-add-user-to-group --profile ldoty --user-pool-id <pool> \
  --username 44f8c468-4011-70b8-76aa-ec2b68b0b004 --group-name lukes_go
node tools/go/scripts/upload.mjs
npm run test:live
```
