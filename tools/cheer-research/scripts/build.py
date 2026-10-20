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

    # Structures (optional): the forms a company can take and companies that chose them. Their chapters are
    # marked section "structures" and show on that tab instead of the guide.
    for c in g['chapters']:
        check(c.get('section') in (None, 'structures'), f"{c['id']}: unknown section {c.get('section')}")
    s = g.get('structure')
    if s:
        forms = [f['id'] for f in s['forms']]
        check(len(set(forms)) == len(forms), 'duplicate structure form id')
        for f in s['forms']:
            check(f.get('label') in LABELS, f"{f['id']}: no C/R/E label")
        cids = [c['id'] for c in s['companies']]
        check(len(set(cids)) == len(cids), 'duplicate company id')
        for c in s['companies']:
            check(c['group'] in s['groups'], f"{c['id']}: unknown group {c['group']}")
            for sid in c.get('structureIds', []):
                check(sid in forms, f"{c['id']}: unknown structure {sid}")
            check(c.get('label') in LABELS, f"{c['id']}: no C/R/E label")
            q = c.get('quote')
            check(q is None or (q.get('text') and q.get('by') and q.get('src')), f"{c['id']}: a quote needs text, by and src")
    else:
        check(not any(c.get('section') for c in g['chapters']), 'structures chapters without a structure section')

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
          f"{len(guide['flows'])} flows, {len(guide['cards'])} cards, "
          f"{len(guide.get('structure', {}).get('companies', []))} companies, {len(text.encode()):,} bytes")
