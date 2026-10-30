# Archive

`https://archive.dot-y.co/` · permission group **`family_archive`** · kept by **Molly** (molly@dot-y.co, coming)

The family's documents: files in **drawers**, with folders, descriptions, tags and links between files.
Everyone has their own drawer (made the first time they look); a drawer is its maker's until they share
it with people or family groups, to see (read) or to file into (edit), as Lists does (`platform/api/sharing.mjs`).

| Folder | What |
|---|---|
| `api/api.mjs` | The API: drawers, search, files, uploads, links (routes at the top of the file) |
| `api/intake.mjs` | Runs on every new file: checks it, reads its text (PDFs, text files), files it. No Claude |
| `api/dot.mjs` | The manifest: how Claude Code (`platform/mcp`), and later Dot, use the archive as the person |
| `infra/` | OpenTofu root: table, bucket + key (`storage.tf`), intake (`intake.tf`), API (`api.tf`) |
| `web/` | The page: drawers and their folders, search, upload (hashed in the browser, straight to S3), a file's card (describe, move, trash, restore), drawers and sharing, delete for good |

## How files move

1. **Upload**: `POST /uploads` with each file's name, size and SHA-256. New files get a presigned PUT
   (15 minutes) that carries the size and checksum, so S3 refuses any other bytes, and no file passes
   through a Lambda. Files already in a drawer the person can see come back as duplicates. Duplicates in
   drawers they can't see aren't mentioned, so an upload never reveals someone else's private files.
2. **Intake** (S3 event on `f/`): checks the size and checksum against what was promised, reads the text
   into `text/<id>.txt`, and marks the file `filed`. A mismatch is `rejected` and never shown.
3. **Filing**: rename, move (folder or drawer), describe (title, summary, kind, the document's own date,
   tags), link (`renews`, `receipt for`, …), trash and restore: all `rev`-checked, all logged.

Keys are ids, never names (`f/<id>`, written once), so moves and renames never touch S3. Trash is a
status. Deleting for good is the drawer owner's, on the page, for a file already in the trash
(`DELETE /files/{id}`, never from a borrowed token): it deletes the object and its text, which versioning
keeps 30 more days.

## Access

The four checks, plus: a borrowed token (Claude Code through `platform/mcp`; `delegates = ["mcp"]`) reads
and uses only the manifest's writes (upload, update, link, unlink), never drawers or sharing. Document
text is someone else's writing: the API says so with every chunk (`TEXT_NOTE`). Intake's role is the
narrowest (read `f/`, write `text/`, write rows), because it parses untrusted files.

## Rows

| pk | sk | What |
|---|---|---|
| `DRAWER` | `<id>` | `{ name, notes, owner, share, rev }`; a person's own is `p-<sub>` |
| `D#<drawer>` | `F#<fileId>` | A file: name, folder, title, summary, kind, docDate, tags, size, type, sha256, status, hasText, pages, rev |
| `FILE` | `<fileId>` | `{ drawer }`: where a file is, so ids and links survive moves |
| `H#<sha256>` | `<fileId>` | `{ drawer }`: files with these bytes |
| `L#<fileId>` | `<otherId>` | `{ relation, dir }`: a link, stored both ways |
| `LOG#<drawer>` | `<time>#<fileId>#<n>` | `{ by, via, action, detail }` |

## Deploy

```sh
npm run build                    # bundles api.mjs and intake.mjs (S3 presigner, unpdf)
cd tools/archive/infra && tofu plan && tofu apply
npm run test:live
```
