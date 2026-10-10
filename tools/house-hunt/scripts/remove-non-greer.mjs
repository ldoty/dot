#!/usr/bin/env node
// One-off (2026-10-10): we're only looking in Greer now. Deletes listings whose address isn't in
// Greer (isGreer: the city, or a Greer zip in the address), the same rule the email ingest now
// applies. A row someone saved since it was read is skipped. Dry run unless --apply.
//   AWS_PROFILE=ldoty node tools/house-hunt/scripts/remove-non-greer.mjs [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isGreer } from '../api/listing.mjs';

const TABLE = 'family-house-hunt';
const APPLY = process.argv.includes('--apply');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const { Items } = await db.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': 'TOOL', ':p': 'LISTING#' },
}));
const gone = Items.filter((row) => !isGreer(row.city, row.address));
for (const row of gone) {
  console.log(`${row.address} | ${row.city || '(no city)'} | ${row.hoodId || 'unsorted'}${row.rejected ? ' | rejected' : ''}${row.notes ? ' | has notes' : ''}`);
  if (!APPLY) continue;
  try {
    await db.send(new DeleteCommand({
      TableName: TABLE, Key: { pk: 'TOOL', sk: row.sk },
      ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev },
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    console.log('  skipped: changed meanwhile, run again');
  }
}
console.log(`\n${gone.length} of ${Items.length} listings outside Greer.${APPLY ? '' : ' Dry run; --apply to delete.'}`);
