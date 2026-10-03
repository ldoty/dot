# Biomap

`https://biomap.dot-y.co/` · permission group **`lukes_biomap`** (Luke only) · progress table `family-biomap`

A field deck of what's been found and identified at each site: a taxonomy tree of notes and specimen
photos, and a spaced-repetition flashcard app built from it.

| Where | What |
|---|---|
| `collection/` | **Not committed** (gitignored): one folder per site, then Domain → … → species, each with an `info.json`; photos in the deepest folder; unsorted photos in `to_categorize/` |
| `scripts/build.py` | Walks `collection/`, writes `.build/deck.json` (see `scripts/FLASHCARDS.md` for the info.json schema) |
| `scripts/publish.sh` | Build, shrink photos to 1600px JPEG, sync deck + photos to the private collection bucket |
| `web/index.html` | The flashcard app (Study / Collection / Progress) |
| `api/api.mjs` | `GET /deck` (with 1-hour signed photo URLs), `GET`/`PUT /progress` |
| `infra/` | OpenTofu root: sign-in client + group, site, API, progress table, private collection bucket |

## Adding to the collection

1. Make folders down to the new taxon under `collection/<site>/…`, drop the photo in the deepest one
   (convert HEIC first: `sips -s format jpeg in.heic --out out.jpg`).
2. `python3 tools/biomap/scripts/build.py --stub`, fill in the new `info.json` files.
3. `tools/biomap/scripts/publish.sh`. The app picks it up on the next load.

## Progress

Saved in the browser and synced to your account after every grade, so devices share one history.
If two devices save at once, the histories merge card by card (more reviews wins). Export/Import in
the Progress view still work. Cards are keyed by folder path, so renaming a folder resets its cards.

## Deploy

```sh
npm run build                                   # bundles the API with its packages
cd tools/biomap/infra && tofu apply
cd ../../.. && tools/biomap/scripts/publish.sh
```
