// Cards API (a lukes_cards token, or a delegated one from Dot or Claude Code, as the person). Routes:
//   GET    /dot                                -> this tool's description for Dot and Claude Code
//   GET    /decks                              -> [{ id, name, kind, cards, due, new }]
//   POST   /decks                              { name, kind? } -> 201 the deck
//   PUT    /decks/{deck}                       { name, rev } -> the deck (rev-checked; its kind stays)
//   DELETE /decks/{deck}                       -> { id, cards } the deck and every card in it
//   GET    /decks/{deck}/cards                 -> [card…] (with each mode's schedule)
//   POST   /decks/{deck}/cards                 { …a card of the deck's kind (model.mjs) } -> 201 the card
//   POST   /decks/{deck}/import                { text } -> { added, skipped: [line numbers] } one card a line
//   PUT    /decks/{deck}/cards/{id}            { …the card, rev } -> the card (rev-checked; schedules kept for kept modes)
//   DELETE /decks/{deck}/cards/{id}            -> { id }
//   POST   /decks/{deck}/cards/{id}/review     { mode, grade: again | hard | good | easy, ms? } -> { schedule }
//   GET    /study[?deck=<id>][&modes=a,b]      -> { due: [item…], new: [item…], newLeft } what to study now: every due
//                                                 review (oldest first), then new ones up to today's limit
//   GET    /summary                            -> { decks, today: { reviews, again, minutes }, streak, due }
// Dot and Claude Code may read everything, make decks and add cards (additions only: nothing to ask
// first); never change, delete, import or review (writeRoutes(MANIFEST) is their allowlist).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
//
// Rows: DECK / <id>                 { name, kind, rev, createdAt }
//       CARD#<deck> / <id>          { kind, front, back | word, definition, example, pos; notes, modes,
//                                     sched: { <mode>: schedule.mjs }, rev, createdAt, createdVia }
//       STAT / <local date>         { reviews, again, ms, rev } a day's studying, for the streak
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest, writeRoutes } from './dot-manifest.mjs';
import { ID, KINDS, MODES, cleanCard, cleanDeck, parseImport, schedulesFor } from './model.mjs';
import { GRADES, isDue, isNew, review } from './schedule.mjs';

export const NEW_PER_DAY = 20;
export const MAX_DECKS = 100;
export const MAX_CARDS = 5000;  // a deck
const MAX_IMPORT = 500;         // lines at once
const MAX_STUDY = 200;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const newId = () => randomBytes(8).toString('hex').slice(0, 12);

const CARD_FIELDS = {
  front: { type: 'string', maxLength: 1000, description: 'basic: the question or prompt side' },
  back: { type: 'string', maxLength: 2000, description: 'basic: the answer side' },
  reverse: { type: 'boolean', description: 'basic: also study it back to front' },
  word: { type: 'string', maxLength: 100, description: 'word: the word, spelled correctly' },
  definition: { type: 'string', maxLength: 1000, description: 'word: what it means, in plain words' },
  example: { type: 'string', maxLength: 500, description: 'word: a sentence using it' },
  pos: { type: 'string', maxLength: 30, description: 'word: part of speech (noun, verb, adjective…)' },
  notes: { type: 'string', maxLength: 1000, description: 'Anything else: origin, a mnemonic' },
};

export const MANIFEST = validateManifest({
  name: 'cards',
  title: 'Cards',
  description: 'Luke’s flashcards: decks of basic cards (front and back) and word cards (word, definition, example; studied for meaning, recall and spelling), with spaced repetition.',
  operations: [{
    name: 'decks',
    description: 'His decks: each one’s id, name, kind (basic or word: what its cards are), how many cards, how many are due now and how many are new.',
    path: '/decks',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'cards',
    description: 'Every card in one deck, by its id from cards_decks, with when each way of studying it comes back.',
    path: '/decks/{deck}/cards',
    input: { type: 'object', properties: { deck: { type: 'string', pattern: '^[a-z0-9]{6,24}$' } }, required: ['deck'], additionalProperties: false },
  }, {
    name: 'summary',
    description: 'How his studying is going: today’s reviews and misses, minutes, his streak of days in a row, and what’s due in each deck.',
    path: '/summary',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'deck_create',
    description: 'Make a deck. kind "word" for vocabulary and spelling (its cards are words), "basic" for anything else (front and back).',
    method: 'POST',
    path: '/decks',
    input: {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 60 }, kind: { type: 'string', enum: KINDS } },
      required: ['name'],
      additionalProperties: false,
    },
  }, {
    name: 'card_add',
    description: 'Add a card to a deck, by its id from cards_decks, in the deck’s kind. A word deck: word, definition (plain, short), and a natural example sentence; '
      + 'check the spelling, and fill in what he didn’t give. A basic deck: front and back. Look at the deck first so you don’t add a card it already has.',
    method: 'POST',
    path: '/decks/{deck}/cards',
    input: { type: 'object', properties: { deck: { type: 'string', pattern: '^[a-z0-9]{6,24}$' }, ...CARD_FIELDS }, required: ['deck'], additionalProperties: false },
  }],
});

const DELEGATED_WRITES = writeRoutes(MANIFEST);

/** A local date, YYYY-MM-DD */
const dayIn = (t, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** deps: db, table, group, issuer, clientIds, dotClientId, now(), timeZone */
export function createApi(deps) {
  const { db, table } = deps;
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  async function all(pk) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  async function putAt(item, rev) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: item,
        ...(rev === undefined
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  const del = (pk, sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
  const nowIso = () => deps.now().toISOString();
  const today = () => dayIn(deps.now(), deps.timeZone);

  const deckOut = (d) => ({ id: d.sk, name: d.name, kind: d.kind, rev: d.rev, createdAt: d.createdAt });
  const cardOut = (c, deck) => {
    const { pk, sk, ...rest } = c;
    return { id: sk, deck, ...rest };
  };
  const counts = (cards) => {
    const t = nowIso();
    let due = 0, fresh = 0;
    for (const c of cards) for (const m of c.modes) {
      if (isDue(c.sched[m], t)) due++;
      else if (isNew(c.sched[m])) fresh++;
    }
    return { cards: cards.length, due, new: fresh };
  };

  async function decksWithCounts() {
    const decks = await all('DECK');
    const cards = await Promise.all(decks.map((d) => all(`CARD#${d.sk}`)));
    return decks.map((d, i) => ({ ...deckOut(d), ...counts(cards[i]), _cards: cards[i] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function addCards(deck, inputs, via) {
    const existing = await all(`CARD#${deck.sk}`);
    if (existing.length + inputs.length > MAX_CARDS) return json(400, { error: `a deck holds at most ${MAX_CARDS} cards` });
    const t = nowIso();
    const added = [];
    for (const card of inputs) {
      const item = { pk: `CARD#${deck.sk}`, sk: newId(), ...card, sched: schedulesFor(card.modes), rev: 1, createdAt: t, createdVia: via };
      await putAt(item);
      added.push(cardOut(item, deck.sk));
    }
    return added;
  }

  /** What to study now: due reviews, oldest first, then new ones up to what's left of today's limit */
  async function study(deckId, modes) {
    const allDecks = await decksWithCounts();
    const decks = allDecks.filter((d) => !deckId || d.id === deckId);
    if (deckId && !decks.length) return json(404, { error: 'no such deck' });
    const t = nowIso(), day = today();
    const items = decks.flatMap((d) => d._cards.flatMap((c) => c.modes.filter((m) => !modes || modes.includes(m))
      .map((m) => ({ deck: d.id, deckName: d.name, id: c.sk, mode: m, card: cardOut(c, d.id), schedule: c.sched[m] }))));
    // Today's new ones count against the limit across every deck, however they were studied
    const introduced = allDecks.flatMap((d) => d._cards).reduce((n, c) => n + Object.values(c.sched).filter((s) => s.seen && dayIn(new Date(s.seen), deps.timeZone) === day).length, 0);
    const newLeft = Math.max(0, NEW_PER_DAY - introduced);
    const due = items.filter((x) => isDue(x.schedule, t)).sort((a, b) => (a.schedule.due < b.schedule.due ? -1 : 1)).slice(0, MAX_STUDY);
    const fresh = items.filter((x) => isNew(x.schedule)).sort((a, b) => (a.card.createdAt < b.card.createdAt ? -1 : a.card.createdAt > b.card.createdAt ? 1 : MODES[a.card.kind].indexOf(a.mode) - MODES[b.card.kind].indexOf(b.mode)))
      .slice(0, newLeft);
    return json(200, { due, new: fresh, newLeft });
  }

  async function record(grade, ms) {
    const day = today();
    for (let i = 0; i < 5; i++) {
      const row = await get('STAT', day);
      const item = { pk: 'STAT', sk: day, reviews: (row?.reviews ?? 0) + 1, again: (row?.again ?? 0) + (grade === 'again' ? 1 : 0), ms: (row?.ms ?? 0) + ms, rev: (row?.rev ?? 0) + 1 };
      if (await putAt(item, row?.rev)) return;
    }
  }

  async function summary() {
    const decks = await decksWithCounts();
    const stats = new Map((await all('STAT')).map((s) => [s.sk, s]));
    const day = today();
    // Days in a row with a review, counting back from today (or yesterday, if today hasn't started yet)
    let streak = 0;
    let d = stats.has(day) ? day : dayIn(new Date(deps.now().getTime() - 86_400_000), deps.timeZone);
    while (stats.has(d)) {
      streak++;
      d = dayIn(new Date(Date.parse(`${d}T12:00:00Z`) - 86_400_000), 'UTC');
    }
    const s = stats.get(day);
    return json(200, {
      decks: decks.map(({ _cards, ...x }) => x),
      today: { reviews: s?.reviews ?? 0, again: s?.again ?? 0, minutes: Math.round((s?.ms ?? 0) / 60_000) },
      streak, due: decks.reduce((n, x) => n + x.due, 0),
    });
  }

  return async function handler(event) {
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientIds, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const delegated = claims.via === 'dot' || (!!deps.dotClientId && claims.client_id === deps.dotClientId);
    const route = event.routeKey;
    if (delegated && !route?.startsWith('GET ') && !DELEGATED_WRITES.includes(route)) {
      console.warn('denied: a delegated token may only read and add', route, claims.username);
      return json(403, { error: 'read-only' });
    }
    let body = {};
    if (event.body && !route.startsWith('GET ') && !route.startsWith('DELETE ')) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad json' });
    }
    const p = event.pathParameters ?? {};
    if ((p.deck !== undefined && !ID.test(p.deck)) || (p.id !== undefined && !ID.test(p.id))) return json(404, { error: 'not found' });
    const via = delegated ? 'delegated' : 'page';
    const deck = p.deck ? await get('DECK', p.deck) : null;
    if (p.deck && !deck) return json(404, { error: 'no such deck' });

    switch (route) {
      case 'GET /dot':
        return json(200, MANIFEST);
      case 'GET /decks':
        return json(200, (await decksWithCounts()).map(({ _cards, ...x }) => x));
      case 'POST /decks': {
        let d;
        try { d = cleanDeck(body); } catch (e) { return json(400, { error: `bad ${e.message}` }); }
        const decks = await all('DECK');
        if (decks.length >= MAX_DECKS) return json(400, { error: `at most ${MAX_DECKS} decks` });
        const same = decks.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
        if (same) return json(409, { error: 'there’s already a deck with that name', current: deckOut(same) });
        const item = { pk: 'DECK', sk: newId(), ...d, rev: 1, createdAt: nowIso(), createdVia: via };
        await putAt(item);
        console.log('deck made', JSON.stringify({ id: item.sk, via }));
        return json(201, deckOut(item));
      }
      case 'PUT /decks/{deck}': {
        let d;
        try { d = cleanDeck({ ...body, kind: deck.kind }); } catch (e) { return json(400, { error: `bad ${e.message}` }); }
        if (body.rev !== deck.rev) return json(409, { error: 'changed meanwhile', current: deckOut(deck) });
        const item = { ...deck, name: d.name, rev: deck.rev + 1 };
        if (!(await putAt(item, deck.rev))) return json(409, { error: 'changed meanwhile', current: deckOut(await get('DECK', deck.sk)) });
        return json(200, deckOut(item));
      }
      case 'DELETE /decks/{deck}': {
        const cards = await all(`CARD#${deck.sk}`);
        for (const c of cards) await del(c.pk, c.sk);
        await del('DECK', deck.sk);
        console.log('deck deleted', JSON.stringify({ id: deck.sk, cards: cards.length }));
        return json(200, { id: deck.sk, cards: cards.length });
      }
      case 'GET /decks/{deck}/cards':
        return json(200, (await all(`CARD#${deck.sk}`)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((c) => cardOut(c, deck.sk)));
      case 'POST /decks/{deck}/cards': {
        let card;
        try { card = cleanCard(body, deck.kind); } catch (e) { return json(400, { error: `bad ${e.message}` }); }
        const r = await addCards(deck, [card], via);
        return Array.isArray(r) ? json(201, r[0]) : r;
      }
      case 'POST /decks/{deck}/import': {
        const { cards, skipped } = parseImport(body.text, deck.kind);
        if (cards.length + skipped.length > MAX_IMPORT) return json(400, { error: `at most ${MAX_IMPORT} lines at once` });
        const r = await addCards(deck, cards, via);
        return Array.isArray(r) ? json(200, { added: r.length, skipped }) : r;
      }
      case 'PUT /decks/{deck}/cards/{id}': {
        const row = await get(`CARD#${deck.sk}`, p.id);
        if (!row) return json(404, { error: 'no such card' });
        let card;
        try { card = cleanCard(body, deck.kind); } catch (e) { return json(400, { error: `bad ${e.message}` }); }
        if (body.rev !== row.rev) return json(409, { error: 'changed meanwhile', current: cardOut(row, deck.sk) });
        const item = { pk: row.pk, sk: row.sk, ...card, sched: schedulesFor(card.modes, row.sched), rev: row.rev + 1, createdAt: row.createdAt, createdVia: row.createdVia };
        if (!(await putAt(item, row.rev))) return json(409, { error: 'changed meanwhile', current: cardOut(await get(row.pk, row.sk), deck.sk) });
        return json(200, cardOut(item, deck.sk));
      }
      case 'DELETE /decks/{deck}/cards/{id}':
        await del(`CARD#${deck.sk}`, p.id);
        return json(200, { id: p.id });
      case 'POST /decks/{deck}/cards/{id}/review': {
        const { mode, grade } = body;
        const ms = Number.isFinite(body.ms) ? Math.min(Math.max(0, Math.round(body.ms)), 10 * 60_000) : 0;
        if (!GRADES.includes(grade)) return json(400, { error: `grade: ${GRADES.join(', ')}` });
        // A review is saved against the card as it is now, retried if something else saved it meanwhile
        for (let i = 0; i < 3; i++) {
          const row = await get(`CARD#${deck.sk}`, p.id);
          if (!row) return json(404, { error: 'no such card' });
          if (!row.modes.includes(mode)) return json(400, { error: `mode: ${row.modes.join(', ')}` });
          const schedule = review(row.sched[mode], grade, deps.now());
          if (await putAt({ ...row, sched: { ...row.sched, [mode]: schedule }, rev: row.rev + 1 }, row.rev)) {
            await record(grade, ms);
            return json(200, { schedule });
          }
        }
        return json(409, { error: 'the card kept changing; try again' });
      }
      case 'GET /study': {
        const q = event.queryStringParameters ?? {};
        if (q.deck && !ID.test(q.deck)) return json(404, { error: 'no such deck' });
        const modes = q.modes ? q.modes.split(',') : null;
        if (modes && modes.some((m) => !Object.values(MODES).flat().includes(m))) return json(400, { error: 'modes' });
        return study(q.deck || null, modes);
      }
      case 'GET /summary':
        return summary();
      default:
        return json(404, { error: 'no route' });
    }
  };
}

let live;
export const handler = async (event) => (live ??= createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  table: process.env.TABLE, group: process.env.GROUP, issuer: process.env.ISSUER,
  clientIds: [process.env.CLIENT_ID, process.env.DOT_CLIENT_ID].filter(Boolean), dotClientId: process.env.DOT_CLIENT_ID,
  now: () => new Date(), timeZone: process.env.TIME_ZONE || 'America/New_York',
}))(event);
