// What a card is, and how each kind is studied.
//   basic  { front, back, reverse? }           modes: forward (front -> back), and reverse (back -> front) if asked
//   word   { word, definition, example?, pos? } modes, any of: meaning (word -> what it means),
//                                              recall (meaning -> the word), spell (hear it -> type it)
// Every card may have notes. A deck has a kind (basic or word): the kind its new and imported cards take.
import { fresh } from './schedule.mjs';

export const KINDS = ['basic', 'word'];
export const MODES = { basic: ['forward', 'reverse'], word: ['meaning', 'recall', 'spell'] };
export const ID = /^[a-z0-9]{6,24}$/;
const LIMITS = { front: 1000, back: 2000, word: 100, definition: 1000, example: 500, pos: 30, notes: 1000, deck: 60 };

const text = (v, max, name, required = false) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`${name} required`);
    return null;
  }
  if (typeof v !== 'string') throw new Error(`${name}: text`);
  const s = v.trim();
  if (required && !s) throw new Error(`${name} required`);
  if (s.length > max) throw new Error(`${name}: up to ${max} characters`);
  return s || null;
};

/** A deck from input: { name, kind } (throws with a reason) */
export function cleanDeck(b) {
  const name = text(b.name, LIMITS.deck, 'name', true);
  const kind = b.kind ?? 'basic';
  if (!KINDS.includes(kind)) throw new Error(`kind: ${KINDS.join(' or ')}`);
  return { name, kind };
}

/**
 * A card's content from input, for a card of `kind` (throws with a reason). The modes to study it in default
 * to all that make sense: a basic card one way unless reverse, a word all three ways.
 */
export function cleanCard(b, kind) {
  const notes = text(b.notes, LIMITS.notes, 'notes');
  let card;
  if (kind === 'basic') {
    card = { kind, front: text(b.front, LIMITS.front, 'front', true), back: text(b.back, LIMITS.back, 'back', true), notes };
    if (b.reverse !== undefined && typeof b.reverse !== 'boolean') throw new Error('reverse: true or false');
    card.modes = b.reverse ? ['forward', 'reverse'] : ['forward'];
  } else if (kind === 'word') {
    card = {
      kind, word: text(b.word, LIMITS.word, 'word', true), definition: text(b.definition, LIMITS.definition, 'definition', true),
      example: text(b.example, LIMITS.example, 'example'), pos: text(b.pos, LIMITS.pos, 'pos'), notes,
    };
    card.modes = MODES.word;
  } else {
    throw new Error('kind');
  }
  if (b.modes !== undefined) {
    if (!Array.isArray(b.modes) || !b.modes.length || b.modes.some((m) => !MODES[kind].includes(m))) throw new Error(`modes: some of ${MODES[kind].join(', ')}`);
    card.modes = MODES[kind].filter((m) => b.modes.includes(m));
  }
  return card;
}

/** Schedules for a card's modes: kept for modes it still has, fresh for new ones */
export const schedulesFor = (modes, old = {}) => Object.fromEntries(modes.map((m) => [m, old[m] ?? fresh()]));

/**
 * Pasted lines -> card inputs for a deck of `kind`. One card a line; the parts split on a tab, else on
 * " - ", " — " or ": " (the first one). basic: front, back. word: word, definition, example.
 * -> { cards, skipped: [line numbers] }
 */
export function parseImport(textIn, kind) {
  const cards = [], skipped = [];
  String(textIn ?? '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let parts = line.split('\t');
    if (parts.length < 2) {
      const m = /^(.*?)(?:\s[-—]\s|:\s)(.*)$/.exec(line);
      parts = m ? [m[1], m[2]] : [line];
    }
    parts = parts.map((p) => p.trim());
    const input = kind === 'word' ? { word: parts[0], definition: parts[1], example: parts[2] || undefined } : { front: parts[0], back: parts.slice(1).join(' ').trim() };
    try {
      cards.push(cleanCard(input, kind));
    } catch {
      skipped.push(i + 1);
    }
  });
  return { cards, skipped };
}

/** "pellucid" vs "pellucid " -> same; spelling is checked without case or surrounding space */
export const sameSpelling = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
