// One-off: every item marked v (verify) moves to p (packed list). Backs each trip up to private/
// first, and writes only if nobody saved the trip meanwhile (rev check).
import fs from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = 'family-trip-planner';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const { Items } = await db.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
  ExpressionAttributeValues: { ':pk': 'TOOL', ':p': 'TRIP#' },
}));
for (const row of Items) {
  const n = row.items.filter((i) => i.status === 'v').length;
  if (!n) continue;
  fs.writeFileSync(new URL(`../private/${row.id}-before-v-to-p.json`, import.meta.url), JSON.stringify(row, null, 2));
  const items = row.items.map((i) => (i.status === 'v' ? { ...i, status: 'p' } : i));
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { ...row, items, rev: row.rev + 1, updatedAt: new Date().toISOString() },
    ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev },
  }));
  console.log(`${row.id}: ${n} moved v -> p (rev ${row.rev} -> ${row.rev + 1})`);
}
