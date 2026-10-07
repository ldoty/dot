#!/usr/bin/env node
// One-off (2026-10-07): listings filed from Redfin alerts before listingUrl() existed link to the
// "Go tour" scheduling page or to a Redfin click-tracker. Rewrites each to the home's own page:
//  - tour links through listingUrl() (the same rule the API and ingest now apply)
//  - click-trackers (redmail*.redfin.com) by reading where they redirect, once, from here; kept
//    only if they land on a Redfin home page
// Only the url changes; a row someone saved meanwhile is skipped (rev check). Dry run unless --apply.
//   AWS_PROFILE=ldoty node tools/house-hunt/scripts/fix-listing-urls.mjs [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { listingUrl } from '../api/listing.mjs';

const TABLE = 'family-house-hunt';
const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }), { marshallOptions: { removeUndefinedValues: true } });

async function resolveTracker(url) {
  if (!/^https:\/\/redmail\d*\.redfin\.com\//.test(url)) return url;
  const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA } });
  const to = res.headers.get('location') || '';
  return /^https:\/\/www\.redfin\.com\/.*\/home\/\d+/.test(to) ? to : url;
}

const { Items } = await db.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': 'TOOL', ':p': 'LISTING#' },
}));
for (const row of Items) {
  if (!row.url) continue;
  const url = listingUrl(await resolveTracker(row.url), row.address, row.city);
  if (url === row.url) continue;
  console.log(`${row.address}\n  ${row.url.slice(0, 100)}…\n  → ${url}`);
  if (!APPLY) continue;
  try {
    await db.send(new PutCommand({
      TableName: TABLE, Item: { ...row, url, rev: row.rev + 1 },
      ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev },
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    console.log('  skipped: changed meanwhile, run again');
  }
}
if (!APPLY) console.log('\nDry run; --apply to write.');
