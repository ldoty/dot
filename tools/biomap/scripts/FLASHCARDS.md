# Flashcards

A study deck built from the repository itself. Every folder in the tree carries an
`info.json` describing what defines that taxon; `build.py` turns those files into
flashcards, and `index.html` is the app that drills you on them and tracks what
you actually know.

## Use it

Open `flashcards/index.html` in a browser. That's it — progress is saved in the
browser's local storage for that page.

If specimen photos don't load, your browser is blocking local file access. Run:

    sh flashcards/serve.sh

and open <http://localhost:8787/flashcards/>.

**Keyboard:** `space` reveals the answer, `1`–`4` grade it (Again / Hard / Good / Easy).

## The three views

| View | What it's for |
| --- | --- |
| **Study** | One card at a time, scheduled by how well you knew it last time. Filter by branch (Fungi, Plantae…) or by rank to drill one level of the hierarchy. **Cram all** ignores scheduling and runs the whole deck. |
| **Collection** | The folder tree with a mastery bar on every taxon. The arrow beside a taxon folds its branch (a folded row shows mastery for the whole branch); Expand all / Collapse all sit at the top. Click any row for its full profile — the same content as its `info.json`, formatted. |
| **Progress** | Overall mastery, study streak, weak spots, and a forecast of what comes due when. Export copies your history out as JSON; Import pastes it back, so progress moves between browsers and devices. |

## Where your progress lives

In the browser's local storage, under one key: `biomap.progress.v1`. It's written
after every grade, so a refresh, a browser restart, or a reboot all keep your
place. Nothing is written back into the repository — your review history is not
in the files, and `build.py` never touches it.

That storage is scoped to the page's **origin**, which has one consequence worth
knowing:

| Where you open it | Origin | Progress |
| --- | --- | --- |
| `flashcards/index.html`, double-clicked | `file://` | one store, shared by any local page |
| `http://localhost:8787/flashcards/` via `serve.sh` | `http://localhost:8787` | **a separate store** |
| The published web copy | its own origin | **a separate store** |

So if you study by opening the file directly and later switch to `serve.sh`, the
deck will look untouched — the history is still there, just under the other
origin. Pick one way to open it and stay with it, or use Export/Import in the
Progress view to move your history across.

Clearing site data, or using a private window, wipes it. Export occasionally if
the history matters to you.

## Scheduling

A trimmed SM-2, the algorithm behind Anki. Each card carries an *ease* factor and
an interval; grading **Good** multiplies the interval by the ease, **Easy**
stretches it further, **Hard** shrinks it, and **Again** resets the card and
brings it back later in the same session. Each button shows the interval it will
give you before you press it.

A card counts as *mastered* once it's scheduled 10+ days out. Taxon and rank
mastery is the mean across that group's cards.

## Adding a photo or a new taxon

1. Make the folders down to the new taxon, following the existing hierarchy:
   `Site / Domain / Kingdom / Phylum / Class / Order / Family / Genus / species`
2. Drop the photo in the deepest folder. Any `.jpg`/`.png`/`.webp` is picked up
   automatically — no need to name it anything in particular, and no need to
   mention it in `info.json`. (`.heic` is skipped; browsers can't display it, so
   convert those first: `sips -s format jpeg in.heic --out out.jpg`.)
3. Scaffold the descriptions:

       python3 flashcards/build.py --stub

   That writes a template `info.json` into every folder that's missing one, with
   the rank already filled in from how deep the folder sits. Fill in the fields
   you care about — everything except `name` is optional.
4. Rebuild:

       python3 flashcards/build.py

Steps 3 and 4 are the same command, so in practice it's: add folders, add photo,
run `build.py --stub`, write the descriptions, run `build.py`.

**Your progress survives all of this.** Cards are keyed by folder path plus card
type, so editing an `info.json` keeps that card's review history, and adding new
taxa simply adds new cards at zero mastery. Renaming or moving a folder is the
one thing that resets those cards — they read as new.

Each run also reports what's still unfiled: taxon folders with no `info.json`,
and photos sitting in `to_categorize/`. The Collection view shows the inbox
count too.

### info.json schema

| Field | Becomes |
| --- | --- |
| `name`, `rank` | Card headers, tree rows, the rank card |
| `common_name` | Two cards, scientific ↔ common |
| `summary` | The one-line gloss in the profile panel |
| `defining_characteristics` | The main recall card. Start a line with `THE` (as in "THE genus trait:") to mark it diagnostic — those get their own reverse-identification card |
| `distinguish_from` | `[{taxon, difference}]` — one "tell apart" card each |
| `sections` | `[{name, traits}]` — for subgroups worth knowing, like the oak sections |
| `key_facts`, `study_notes` | Profile panel only, not drilled |
| `etymology` | An etymology card |
| `lineage` | `["Eukarya", …, "virginiana"]` — the full-classification card. Species only |
| `image` | Overrides photo auto-detection |
| `not_a_taxon` | Set on the site folder; suppresses rank and common-name cards |

## Files

    build.py      walks the tree, writes deck.js and deck.json
    deck.js       generated — the app loads this. Don't edit it
    deck.json     generated — same data, for anything else that wants it
    index.html    the app, self-contained apart from deck.js
    serve.sh      build + local HTTP server

## Naming in the tree

Folder names are the taxon names, so the app can read the hierarchy straight off
the filesystem. Two conventions to keep to when you add folders:

- **Species epithets are lowercase** — `Quercus/virginiana`, not `Virginiana`.
  The genus is capitalised, the epithet is not.
- **Everything above genus is capitalised** — `Basidiomycota`, `Agaricales`.

The app italicises genus and species names automatically, since that's the other
half of the convention.
