#!/usr/bin/env python3
"""Builds the guide the API serves: private/content.json -> private/guide.json.

  python3 tools/cheer-research/scripts/build.py

content.json is written by hand from the research report (private/, gitignored: business research stays out of git).
This checks it, so a typo can't silently drop a card, a flow or a player, and gives each card a stable id
(its topic and question), so saved progress follows a card while other cards are added or removed.
"""
import hashlib, json, os, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVATE = os.path.join(HERE, 'private')
LABELS = {'C', 'R', 'E'}


def check(cond, msg):
    if not cond:
        sys.exit('content.json: ' + msg)


def build(private=PRIVATE):
    g = json.load(open(os.path.join(private, 'content.json')))
    topics = [c['id'] for c in g['chapters']]
    check(len(set(topics)) == len(topics), 'duplicate chapter id')
    for c in g['chapters']:
        for p in c['points']:
            check(p.get('label') in LABELS, f"{c['id']}: point without a C/R/E label: {p['text'][:50]}")

    ids = [p['id'] for p in g['players']]
    check(len(set(ids)) == len(ids), 'duplicate player id')
    for p in g['players']:
        check(p['kind'] in g['kinds'], f"{p['id']}: unknown kind {p['kind']}")
        check(p['role'] in g['roles'], f"{p['id']}: unknown role {p['role']}")
        check(p.get('label') in LABELS, f"{p['id']}: no C/R/E label")

    fids = [f['id'] for f in g['flows']]
    check(len(set(fids)) == len(fids), 'duplicate flow id')
    for f in g['flows']:
        check(f['seg'] in g['segments'], f"{f['id']}: unknown segment {f['seg']}")
        check(f['capture'] in ('high', 'medium', 'low'), f"{f['id']}: capture must be high, medium or low")
        check(0 <= f['low'] <= f['mid'] <= f['high'], f"{f['id']}: low <= mid <= high")
        check(f.get('label') in LABELS, f"{f['id']}: no C/R/E label")

    seen = set()
    for card in g['cards']:
        check(card['topic'] in topics, f"card topic {card['topic']} is not a chapter: {card['q']}")
        card['id'] = card['topic'] + ':' + hashlib.sha1(card['q'].encode()).hexdigest()[:8]
        check(card['id'] not in seen, 'duplicate card: ' + card['q'])
        seen.add(card['id'])
    return g


if __name__ == '__main__':
    guide = build()
    text = json.dumps(guide, ensure_ascii=False, separators=(',', ':'))
    out = os.path.join(PRIVATE, 'guide.json')
    open(out, 'w').write(text)
    print(f"{out}: {len(guide['chapters'])} chapters, {len(guide['players'])} players, "
          f"{len(guide['flows'])} flows, {len(guide['cards'])} cards, {len(text.encode()):,} bytes")
