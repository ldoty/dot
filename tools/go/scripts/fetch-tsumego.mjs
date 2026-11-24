// Life-and-death problems from OGS puzzle collections -> private/tsumego.json (upload.mjs puts them up).
//   node tools/go/scripts/fetch-tsumego.mjs [collection ids…]
// The defaults are around his level (about 10k), three of them on 9x9: easy enough to drill until they're
// seen at a glance, which is the point. One request a collection (it returns every puzzle and its tree).
import { R, ogs, writeJson, PRIVATE } from './lib.mjs';

const DEFAULTS = [975, 985, 7769, 279]; // Ecole de Go de Rennes 15k and 10k, Amigo’s igo 9x9, Cho Chikun Elementary
const ids = process.argv.slice(2).map(Number).filter(Boolean);
const MAX_TREE = 30_000; // bytes; a few huge trees aren't worth the space

/** The tree with only what the page uses: x, y, branches, correct_answer, wrong_answer */
function prune(n) {
  const out = { x: n.x, y: n.y };
  if (n.correct_answer) out.correct_answer = true;
  if (n.wrong_answer) out.wrong_answer = true;
  if (n.branches?.length) out.branches = n.branches.map(prune);
  return out;
}

/** The part of the board the problem is in: its stones and every move in its tree, one line around */
function crop(size, board, tree) {
  const pts = board.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  (function walk(n) { if (n.x >= 0) pts.push(n.y * size + n.x); (n.branches || []).forEach(walk); })(tree);
  if (size <= 9 || !pts.length) return null;
  const xs = pts.map((i) => i % size), ys = pts.map((i) => Math.floor(i / size));
  const c = [Math.max(0, Math.min(...xs) - 1), Math.max(0, Math.min(...ys) - 1), Math.min(size - 1, Math.max(...xs) + 1), Math.min(size - 1, Math.max(...ys) + 1)];
  // Out to the edge when it's close: the edge matters in life and death
  if (c[0] <= 2) c[0] = 0;
  if (c[1] <= 2) c[1] = 0;
  if (c[2] >= size - 3) c[2] = size - 1;
  if (c[3] >= size - 3) c[3] = size - 1;
  return c;
}

const hasRight = (n) => !!n.correct_answer || (n.branches || []).some(hasRight);
const out = [];
for (const id of ids.length ? ids : DEFAULTS) {
  const list = await ogs(`/puzzles/collections/${id}/puzzles`);
  let kept = 0;
  for (const p of list) {
    const z = p.puzzle;
    if (!z || z.width !== z.height || z.width > 19 || !z.move_tree) continue;
    const tree = prune(z.move_tree);
    if (!hasRight(tree) || JSON.stringify(tree).length > MAX_TREE) continue;
    const board = R.fromState(z.width, z.initial_state);
    const text = (z.move_tree.text || '').trim();
    out.push({
      kind: 'tsumego', id: `p${p.id}`, size: z.width, stones: board.join(''), toMove: z.initial_player === 'white' ? 'w' : 'b', last: -1,
      theme: z.puzzle_type || 'life_and_death', rank: Number(z.puzzle_rank) || null, collection: id, name: z.name,
      prompt: text && text.length <= 140 ? text : null, crop: crop(z.width, board, tree), tree,
    });
    kept++;
  }
  console.log(`collection ${id}: ${kept} of ${list.length}`);
}
writeJson(`${PRIVATE}tsumego.json`, out);
console.log(`${out.length} problems -> private/tsumego.json`);
