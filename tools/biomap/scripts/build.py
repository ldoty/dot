#!/usr/bin/env python3
"""
Walk the biomap tree, read every info.json, and generate the flashcard deck.

Reads tools/biomap/collection/ (one folder per site) and writes tools/biomap/.build/deck.json,
which scripts/publish.sh uploads for the app. Image paths in the deck are relative to the
collection root, matching the photo keys publish.sh uploads.

Re-run this whenever you add a taxon folder or edit an info.json.
    python3 tools/biomap/scripts/build.py

Adding a new taxon? Make the folders, drop the photo in, then:
    python3 tools/biomap/scripts/build.py --stub    # writes a template info.json in any
                                          # taxon folder that is missing one
Fill in the stubs, run build.py again, and the cards are there.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.dirname(HERE)
ROOT = os.environ.get("BIOMAP_COLLECTION") or os.path.join(TOOL, "collection")
OUT = os.environ.get("BIOMAP_OUT") or os.path.join(TOOL, ".build")

RANK_ORDER = [
    "Site", "Domain", "Kingdom", "Phylum", "Phylum (Division)",
    "Class", "Order", "Family", "Genus", "Species",
]

SKIP_DIRS = {"flashcards", ".git", "node_modules", "__pycache__"}
INBOX = "to_categorize"
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"}

# A folder's depth below the repository root gives its rank.
DEPTH_RANK = ["Site", "Domain", "Kingdom", "Phylum", "Class",
              "Order", "Family", "Genus", "Species"]

STUB_FIELDS = {
    "common_name": "",
    "pronunciation": "",
    "etymology": "",
    "summary": "",
    "defining_characteristics": [
        "THE diagnostic trait: ... (a line starting with THE also becomes a "
        "reverse-identification card)"
    ],
    "distinguish_from": [{"taxon": "", "difference": ""}],
    "key_facts": [],
}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def walk_taxon_dirs():
    """Every directory in the tree that is a taxon folder, not the inbox."""
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIRS and not d.startswith("."))
        rel = os.path.relpath(dirpath, ROOT)
        if rel == "." or INBOX in rel.split(os.sep):
            continue
        yield dirpath, rel, filenames


def images_in(filenames):
    return [n for n in sorted(filenames)
            if os.path.splitext(n)[1].lower() in IMAGE_EXT]


def stub():
    """Write a template info.json into every taxon folder that lacks one."""
    made = []
    for dirpath, rel, filenames in walk_taxon_dirs():
        if "info.json" in filenames:
            continue
        parts = rel.split(os.sep)
        depth = len(parts) - 1
        data = {"name": parts[-1],
                "rank": DEPTH_RANK[depth] if depth < len(DEPTH_RANK) else ""}
        data.update(STUB_FIELDS)
        with open(os.path.join(dirpath, "info.json"), "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        made.append(rel)

    if made:
        print(f"Wrote {len(made)} stub info.json files - fill these in:")
        for m in made:
            print(f"  {m}/info.json")
    else:
        print("Every taxon folder already has an info.json.")
    return made


def unfiled():
    """Photos sitting in the inbox, and taxon folders still missing an info.json."""
    inbox = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        if os.path.basename(dirpath) == INBOX:
            inbox += images_in(filenames)
    missing = [rel for _, rel, fn in walk_taxon_dirs() if "info.json" not in fn]
    return inbox, missing


def collect():
    """Find every directory holding an info.json, in tree order."""
    taxa = []
    for dirpath, rel, filenames in walk_taxon_dirs():
        if "info.json" not in filenames:
            continue

        with open(os.path.join(dirpath, "info.json")) as f:
            info = json.load(f)

        parts = rel.split(os.sep)
        info["path"] = rel.replace(os.sep, "/")
        info["depth"] = len(parts) - 1
        info["id"] = slug(info["path"])
        # Ancestor folder names, minus the site root, are the taxonomic lineage.
        info["ancestors"] = parts[1:-1]
        # Which kingdom this sits under, for filtering. The site and the
        # domain sit above every kingdom, so they get their own bucket.
        info["branch"] = parts[2] if len(parts) > 2 else "Overview"

        if not info.get("image"):
            # HEIC will not render in a browser, so it is not a candidate.
            imgs = [n for n in images_in(filenames)
                    if not n.lower().endswith(".heic")]
            if imgs:
                info["image"] = imgs[0]
        if info.get("image"):
            info["image_path"] = info["path"] + "/" + info["image"]

        taxa.append(info)

    taxa.sort(key=lambda t: t["path"])
    return taxa


def rank_phrase(rank):
    """'Phylum (Division)' reads badly mid-sentence; trim to the bare rank."""
    return re.sub(r"\s*\(.*\)", "", rank).lower()


def card(cid, taxon, ctype, front, back, hint=None):
    return {
        "id": cid,
        "type": ctype,
        "front": front,
        "back": back,
        "hint": hint,
        "taxon": taxon["name"],
        "taxonId": taxon["id"],
        "rank": taxon.get("rank", ""),
        "branch": taxon.get("branch", ""),
        "path": taxon["path"],
        "image": taxon.get("image_path"),
    }


def build_cards(taxa):
    cards = []

    for t in taxa:
        tid = t["id"]
        name = t["name"]
        rank = t.get("rank", "")
        label = f"{name} ({rank})" if rank else name
        is_taxon = not t.get("not_a_taxon")

        # 1. The core recall card: name -> what defines it.
        chars = t.get("defining_characteristics") or []
        if chars:
            q = (f"What defines the collection site at **{name}**?" if not is_taxon
                 else f"What are the defining characteristics of **{name}**?")
            cards.append(card(
                f"{tid}::defining", t, "defining", q,
                {"kind": "list", "items": chars},
                hint=rank,
            ))

        # 2. Common name, both directions.
        common = t.get("common_name")
        if common and is_taxon:
            cards.append(card(
                f"{tid}::common-fwd", t, "common",
                f"What is the common name for **{name}**?",
                {"kind": "text", "text": common},
                hint=rank,
            ))
            cards.append(card(
                f"{tid}::common-rev", t, "common",
                f"Which {rank_phrase(rank)} is commonly called **{common}**?",
                {"kind": "text", "text": name},
                hint=rank,
            ))

        # 3. Rank placement.
        if is_taxon and rank:
            cards.append(card(
                f"{tid}::rank", t, "rank",
                f"What taxonomic rank is **{name}**?",
                {"kind": "text", "text": rank},
            ))

        # 4. Full lineage, for species only - the payoff card.
        if t.get("lineage"):
            cards.append(card(
                f"{tid}::lineage", t, "lineage",
                f"Give the full classification of **{name}**, Domain to Species.",
                {"kind": "lineage", "items": t["lineage"]},
            ))

        # 5. Where does it sit - parent recall.
        if is_taxon and t["ancestors"]:
            parent = t["ancestors"][-1]
            cards.append(card(
                f"{tid}::parent", t, "parent",
                f"**{name}** belongs to which group directly above it?",
                {"kind": "text", "text": parent},
                hint=f"{rank} -> ?",
            ))

        # 6. Reverse identification from a signature characteristic.
        #    Only characteristics flagged as diagnostic make good ID cards.
        for i, c in enumerate(chars):
            if re.search(r"\bTHE\b|diagnostic|defining structure|at a glance|signature|names the group|single most|fastest field mark|key field mark",
                         c):
                cards.append(card(
                    f"{tid}::identify-{i}", t, "identify",
                    f"Which {rank_phrase(rank)} is this?\n\n_{c}_",
                    {"kind": "text", "text": label},
                ))

        # 7. Contrast cards - one per confusable neighbour.
        for i, d in enumerate(t.get("distinguish_from") or []):
            cards.append(card(
                f"{tid}::contrast-{i}", t, "contrast",
                f"How do you tell **{name}** from **{d['taxon']}**?",
                {"kind": "text", "text": d["difference"]},
                hint=rank,
            ))

        # 8. Etymology - the mnemonic that makes the name stick.
        ety = t.get("etymology")
        if ety and is_taxon:
            cards.append(card(
                f"{tid}::etymology", t, "etymology",
                f"Where does the name **{name}** come from?",
                {"kind": "text", "text": ety},
            ))

        # 9. Photo identification, for anything with a specimen photo.
        if t.get("image_path"):
            cards.append(card(
                f"{tid}::photo", t, "photo",
                "Identify this specimen.",
                {"kind": "text", "text": f"{name}" + (f" - {common}" if common else "")},
                hint=t.get("branch"),
            ))

        # 10. Sub-groupings worth knowing (e.g. the oak sections).
        for i, s in enumerate(t.get("sections") or []):
            cards.append(card(
                f"{tid}::section-{i}", t, "section",
                f"In **{name}**, what characterises **{s['name']}**?",
                {"kind": "text", "text": s["traits"]},
            ))

    return cards


def main():
    if "--stub" in sys.argv:
        stub()
        print()

    taxa = collect()
    if not taxa:
        print("No info.json files found. Nothing to build.", file=sys.stderr)
        return 1

    cards = build_cards(taxa)
    inbox_now, _ = unfiled()
    deck = {
        "generated_from": os.path.basename(ROOT),
        "inbox": len(inbox_now),
        "rank_order": RANK_ORDER,
        "taxa": taxa,
        "cards": cards,
    }

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "deck.json"), "w") as f:
        json.dump(deck, f, indent=2, ensure_ascii=False)
        f.write("\n")

    by_type = {}
    for c in cards:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1
    print(f"{len(taxa)} taxa -> {len(cards)} cards")
    for k in sorted(by_type, key=lambda k: -by_type[k]):
        print(f"  {by_type[k]:>4}  {k}")

    inbox, missing = unfiled()
    if missing:
        print(f"\n{len(missing)} taxon folder(s) have no info.json, so they make no cards:")
        for m in missing:
            print(f"  {m}")
        print("  Run with --stub to scaffold them.")
    if inbox:
        print(f"\n{len(inbox)} photo(s) still in {INBOX}/: " + ", ".join(inbox))
    return 0


if __name__ == "__main__":
    sys.exit(main())
