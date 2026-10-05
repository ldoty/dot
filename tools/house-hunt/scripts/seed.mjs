#!/usr/bin/env node
// Loads scripts/hoods.mjs into House Hunt, plus personal map places from private/house-hunt-places.json
// (git-ignored) when it exists. Safe to re-run:
//  - a new neighborhood is added
//  - one nobody has edited yet (updatedBy = seed) is refreshed from hoods.mjs
//  - one a person has edited only gets fields that are still empty; their edits and notes stay
//  - places are read-only in the app, so they're always replaced
//   node tools/house-hunt/scripts/seed.mjs
import { existsSync, readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HOODS, PLACES } from './hoods.mjs';

const TABLE = 'family-house-hunt';
process.env.AWS_PROFILE ??= 'ldoty';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } });
const PRIVATE = new URL('../../../private/house-hunt-places.json', import.meta.url);
const OLD_STATUS = { considering: 'explore', visited: 'explore', favorite: 'shortlist', pass: 'nogo' };
const EMPTY = { summary: '', pool: '', elementary: '', middle: '', high: '', schoolNote: '', price: null, priceNote: '', sales: null,
  status: 'explore', rank: null, visited: '', fitNote: '', facts: [], drives: [], ll: null, notes: '', source: '' };
const blank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

const put = (Item, rev) => db.send(new PutCommand({
  TableName: TABLE, Item,
  ...(rev ? { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } } : { ConditionExpression: 'attribute_not_exists(pk)' }),
}));

const now = new Date().toISOString();
for (const [i, { id, ...h }] of HOODS.entries()) {
  const sk = `HOOD#${id}`;
  const fresh = { ...EMPTY, ...h, order: i + 1 };
  const { Item: old } = await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'TOOL', sk } }));
  if (!old) {
    await put({ pk: 'TOOL', sk, ...fresh, rev: 1, updatedAt: now, updatedBy: 'seed', updatedByName: '' });
    console.log(`${h.name}: added`);
  } else if (old.updatedBy === 'seed') {
    await put({ ...old, ...fresh, notes: old.notes || '', rev: old.rev + 1, updatedAt: now }, old.rev);
    console.log(`${h.name}: refreshed`);
  } else {
    const fill = Object.fromEntries(Object.entries(fresh).filter(([k]) => k !== 'status' && blank(old[k]) && !blank(fresh[k])));
    const status = OLD_STATUS[old.status] ?? old.status;
    if (!Object.keys(fill).length && status === old.status) { console.log(`${h.name}: edited by someone, nothing to fill`); continue; }
    await put({ ...old, ...fill, status, rev: old.rev + 1, updatedAt: now }, old.rev);
    console.log(`${h.name}: edited by someone; filled ${Object.keys(fill).join(', ') || 'status'}`);
  }
}

const places = [...PLACES, ...(existsSync(PRIVATE) ? JSON.parse(readFileSync(PRIVATE, 'utf8')) : [])];
for (const { id, ...p } of places) {
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk: 'TOOL', sk: `PLACE#${id}`, ...p, ll: p.ll ?? null, updatedAt: now } }));
  console.log(`place ${p.name}: saved`);
}
if (!existsSync(PRIVATE)) console.log('(no private/house-hunt-places.json: family places skipped)');
