// build.py on a small throwaway collection: the deck it writes for publish.sh
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILD = new URL('../scripts/build.py', import.meta.url).pathname;

function collection() {
  const root = mkdtempSync(join(tmpdir(), 'biomap-'));
  const dir = (...p) => { const d = join(root, 'col', ...p); mkdirSync(d, { recursive: true }); return d; };
  const info = (d, o) => writeFileSync(join(d, 'info.json'), JSON.stringify(o));
  info(dir('1.0,2.0'), { name: '1.0, 2.0', rank: 'Site', not_a_taxon: true, defining_characteristics: ['A park'] });
  info(dir('1.0,2.0', 'Eukarya'), { name: 'Eukarya', rank: 'Domain' });
  info(dir('1.0,2.0', 'Eukarya', 'Fungi'), { name: 'Fungi', rank: 'Kingdom', common_name: 'Fungi', defining_characteristics: ['THE trait: chitin walls'] });
  const sp = dir('1.0,2.0', 'Eukarya', 'Fungi', 'Basidiomycota');
  info(sp, { name: 'Basidiomycota', rank: 'Phylum' });
  writeFileSync(join(sp, 'cap.jpg'), 'jpg');
  writeFileSync(join(sp, 'raw.heic'), 'heic');
  const inbox = dir('1.0,2.0', 'to_categorize');
  writeFileSync(join(inbox, 'IMG_1.heic'), 'x');
  return { root, col: join(root, 'col'), out: join(root, 'out') };
}

test('builds the deck from the collection, with collection-relative photo paths', () => {
  const c = collection();
  const log = execFileSync('python3', [BUILD], { env: { ...process.env, BIOMAP_COLLECTION: c.col, BIOMAP_OUT: c.out }, encoding: 'utf8' });
  assert.match(log, /4 taxa ->/);
  assert.match(log, /1 photo\(s\) still in to_categorize/);
  const deck = JSON.parse(readFileSync(join(c.out, 'deck.json'), 'utf8'));
  const phylum = deck.taxa.find((t) => t.name === 'Basidiomycota');
  assert.equal(phylum.image_path, '1.0,2.0/Eukarya/Fungi/Basidiomycota/cap.jpg', 'no "../" prefix; HEIC skipped');
  assert.equal(phylum.branch, 'Fungi');
  assert.ok(deck.cards.some((k) => k.type === 'identify' && k.taxon === 'Fungi'), 'THE-lines become identification cards');
  assert.ok(deck.cards.some((k) => k.type === 'photo'));
  assert.equal(deck.inbox, 1);
  assert.equal(existsSync(join(c.out, 'deck.js')), false, 'no deck.js any more');
});
