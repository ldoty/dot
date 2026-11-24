// Puts the drill bank (classify.mjs -> private/bank.json, fetch-tsumego.mjs -> private/tsumego.json) and the
// error database into the deployed table, as profile ldoty.
//   node tools/go/scripts/upload.mjs [--dry]
// A drill already there keeps its schedule (his history); only its lines are brought up to date. The error
// database (PROFILE / mistakes) and his games week by week (WEEK / <monday>) are replaced each time. What goes up:
//   fix      every one of his mistakes, and up to OTHERS_PER_THEME of his opponents' per kind, the costliest first
//   threat   up to MAX_THREATS, his own first, then the biggest
//   count    up to MAX_COUNTS
//   tsumego  all of them
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { fresh } from '../../../platform/api/schedule.mjs';
import { PRIVATE, readJson } from './lib.mjs';

const OTHERS_PER_THEME = 80;
const MAX_THREATS = 300;
const MAX_COUNTS = 300;
const TABLE = 'family-go';
const dry = process.argv.includes('--dry');

const bank = readJson(`${PRIVATE}bank.json`);
if (!bank) throw new Error('no private/bank.json: run analyze.mjs and classify.mjs first');
const tsumego = readJson(`${PRIVATE}tsumego.json`, []);

const byTheme = {};
for (const d of bank.fix.filter((x) => !x.mine)) (byTheme[d.theme] ??= []).push(d);
const fix = [...bank.fix.filter((x) => x.mine), ...Object.values(byTheme).flatMap((ds) => ds.sort((a, b) => b.loss - a.loss).slice(0, OTHERS_PER_THEME))];
const threat = [...bank.threat].sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || b.cost - a.cost).slice(0, MAX_THREATS);
const count = bank.count.slice(0, MAX_COUNTS);
const all = [...fix, ...threat, ...count, ...tsumego];
console.log(`fix ${fix.length} (${fix.filter((x) => x.mine).length} yours), threat ${threat.length}, count ${count.length}, tsumego ${tsumego.length}`);
if (dry) process.exit(0);

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1', profile: 'ldoty' }));
const now = new Date().toISOString();
let added = 0, kept = 0;
const queue = [...all];
async function worker() {
  while (queue.length) {
    const { id, ...d } = queue.shift();
    // A problem's tree can nest deeper than DynamoDB's 32 levels: it's kept as JSON text
    if (d.tree && typeof d.tree !== 'string') d.tree = JSON.stringify(d.tree);
    try {
      await db.send(new PutCommand({
        TableName: TABLE, ConditionExpression: 'attribute_not_exists(pk)',
        Item: { pk: `DRILL#${d.kind}`, sk: id, ...d, sched: fresh(), rev: 1, createdAt: now },
      }));
      added++;
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      kept++;
      // Already there: its schedule stays, but lines worked out since are added
      if (d.lines) await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: `DRILL#${d.kind}`, sk: id }, UpdateExpression: 'SET #l = :l', ExpressionAttributeNames: { '#l': 'lines' }, ExpressionAttributeValues: { ':l': d.lines } }));
    }
  }
}
await Promise.all([...Array(8)].map(worker));
await db.send(new PutCommand({ TableName: TABLE, Item: { pk: 'PROFILE', sk: 'mistakes', ...bank.profile, at: bank.at } }));
// His real games week by week, for the program's progress chart (replaced each time)
for (const w of bank.weeks ?? []) await db.send(new PutCommand({ TableName: TABLE, Item: { pk: 'WEEK', sk: w.week, games: w.games, moves: w.moves, byKind: w.byKind } }));
console.log(`added ${added}, already there ${kept}; error database from ${bank.profile.games} games`);
