#!/usr/bin/env python3
"""Builds the guide the API serves: private/research + private/curated.json + private/photos -> private/guide.json.

  python3 tools/boards/scripts/build.py

Everything it reads and writes is under private/ (gitignored): research on real people stays out of git.
Research files: research/people-*.json (one array of people each) and research/orgs.json ({orgs: [...]}).
curated.json holds what was decided by hand: bridges, overlaps, sponsors, the Partner Track lens and the plan.
Photos are photos/<id>.jpg, where id is the person's name lowercased and hyphenated ("Ada M. North" -> ada-north).
"""
import base64, glob, json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVATE = os.path.join(HERE, 'private')
LIMIT = 5_000_000  # the Lambda returns this as one response; keep well under its 6 MB cap


def slug(name):
    name = re.sub(r'^Mayor\s+', '', name)
    name = re.sub(r'\s[A-Z]\.\s', ' ', name)
    return re.sub(r'[^a-z0-9]+', '-', name.lower().replace("'", '')).strip('-')


def build(private=PRIVATE):
    curated = json.load(open(os.path.join(private, 'curated.json')))
    orgs = json.load(open(os.path.join(private, 'research', 'orgs.json')))['orgs']
    orgs.sort(key=lambda o: list(curated['short']).index(o['id']))   # the order curated.json lists them
    org_ids = [o['id'] for o in orgs]

    people, seen = [], set()
    for f in sorted(glob.glob(os.path.join(private, 'research', 'people-*.json'))):
        for p in json.load(open(f)):
            p['id'] = slug(p['name'])
            if p['id'] in seen:
                continue
            if p['org'] not in org_ids:
                sys.exit(f"{p['name']}: unknown org {p['org']}")
            seen.add(p['id'])
            p.pop('photo_url', None)
            p['bridge'] = p['id'] in curated['bridge_people']
            if p['id'] in curated.get('overlap_text', {}):
                p['overlap'] = curated['overlap_text'][p['id']]
            if p['id'] in curated['lens']:
                p['lens'] = curated['lens'][p['id']]
            people.append(p)

    # A curated id that matches no one is a typo that would silently drop a bridge or a lens tag.
    referenced = set(curated['bridge_people']) | set(curated['lens']) | set(curated.get('overlap_text', {}))
    for o in curated['overlaps']:
        referenced |= set(o['people'])
    for ph in curated['plan']['phases']:
        for s in ph['steps']:
            referenced |= set(s['people'])
    unknown = referenced - seen
    if unknown:
        sys.exit('curated.json names people who are not in the research: ' + ', '.join(sorted(unknown)))

    photos = {}
    for f in sorted(glob.glob(os.path.join(private, 'photos', '*.jpg'))):
        pid = os.path.splitext(os.path.basename(f))[0]
        if pid in seen:
            photos[pid] = 'data:image/jpeg;base64,' + base64.b64encode(open(f, 'rb').read()).decode()

    for o in orgs:
        o['short'] = curated['short'][o['id']]
        o['aliases'] = curated['aliases'][o['id']]

    # Board chairs first, then by last name; NextGEN before Artisphere, board before staff.
    def order(p):
        chair = p.get('title', '').lower() in ('chair', 'board chair')
        return (org_ids.index(p['org']), p['group'] != 'board', not chair, p['name'].split()[-1])

    return {
        'people': sorted(people, key=order),
        'orgs': orgs,
        'overlaps': curated['overlaps'],
        'sponsors': curated['sponsors'],
        'lens_tags': curated['lens_tags'],
        'plan': curated['plan'],
        'venn_note': curated['venn_note'],
        'note': curated['note'],
        'photos': photos,
    }


if __name__ == '__main__':
    guide = build()
    text = json.dumps(guide, ensure_ascii=False, separators=(',', ':'))
    if len(text.encode()) > LIMIT:
        sys.exit(f'guide.json is {len(text.encode())} bytes; shrink the photos')
    out = os.path.join(PRIVATE, 'guide.json')
    open(out, 'w').write(text)
    missing = [p['name'] for p in guide['people'] if p['id'] not in guide['photos']]
    print(f"{out}: {len(guide['people'])} people, {len(guide['photos'])} photos, {len(text.encode()):,} bytes")
    print('no photo:', ', '.join(missing) or 'none')
