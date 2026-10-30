import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AMBER, LUKE, archiveApi, borrowed, bucket, call, intake, reset, token, upload } from './helpers/archive.mjs';
import { tinyPdf } from './helpers/pdf.mjs';
import { createBulk, placeOf } from '../api/bulk.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const sha = (b) => createHash('sha256').update(b).digest('base64');
const hashed = new Set();
const bulk = createBulk({
  archive: archiveApi, db, table: 'family-archive', log: () => {},
  s3: {
    // aws s3 cp --checksum-algorithm SHA256 leaves S3's verified checksum on each object
    head: async (key) => ({ size: bucket.get(key).length, sha256b64: key.includes('nochecksum') ? null : sha(bucket.get(key)), type: key.endsWith('.pdf') ? 'application/pdf' : 'text/plain' }),
    hash: async (key) => { hashed.add(key); return createHash('sha256').update(bucket.get(key)).digest('hex'); },
    // The copy lands in f/ and S3's event starts intake
    copy: async (from, to) => { bucket.set(to, bucket.get(from)); await intake({ Records: [{ s3: { object: { key: to } } }] }); },
  },
});
/** What `aws s3 cp --recursive` would do: each file into the batch's prefix, each an S3 event */
async function copyIn(prefix, files) {
  for (const [path, bytes] of Object.entries(files)) {
    const key = prefix + path;
    bucket.set(key, bytes);
    await bulk({ Records: [{ s3: { object: { key: encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+') } } }] });
  }
}
beforeEach(() => { reset(); hashed.clear(); });

test('a batch: credentials for its prefix only, and the command to run', async () => {
  const r = await call('POST', '/batches', { drawer: 'mine', folder: 'Imported' });
  assert.equal(r.status, 200);
  const prefix = `incoming/${LUKE}/${r.body.id}/`;
  assert.equal(r.body.credentials.secretAccessKey, `secret-for-${prefix}`);
  assert.match(r.body.command, new RegExp(`aws s3 cp <folder> s3://archive-test/${prefix} --recursive`));
  assert.match(r.body.command, /--checksum-algorithm SHA256/);
  // Only drawers they can file into
  await call('PUT', '/drawers/lukes-work', { name: 'Work' });
  assert.equal((await call('POST', '/batches', { drawer: 'lukes-work' }, token(AMBER))).status, 404);
});

test('a folder copied in is filed under the batch’s folder, subfolders kept; duplicates skipped; too big refused', async () => {
  await upload('mine', 'Old', [{ name: 'have.txt', bytes: Buffer.from('already here'), type: 'text/plain' }]);
  const b = (await call('POST', '/batches', { drawer: 'mine', folder: 'Imported' })).body;
  const prefix = `incoming/${LUKE}/${b.id}/`;
  await copyIn(prefix, {
    'Taxes/2025/1099 Marcus.pdf': tinyPdf('Form 1099-INT Marcus'),
    'notes.txt': Buffer.from('a note'),
    'again.txt': Buffer.from('already here'),
    'nochecksum.txt': Buffer.from('uploaded without a checksum'),
  });
  const pdf = (await call('GET', '/files?q=1099')).body.files[0];
  assert.equal(pdf.folder, 'Imported/Taxes/2025');
  assert.equal(pdf.name, '1099 Marcus.pdf');
  assert.equal(pdf.hasText, true);
  assert.equal((await call('GET', '/files?folder=Imported')).body.total, 3);
  assert.ok(hashed.has(`${prefix}nochecksum.txt`), 'hashed itself when S3 had no checksum');
  const status = (await call('GET', `/batches/${b.id}`)).body;
  assert.deepEqual([status.filed, status.duplicates, status.refused.length], [3, 1, 0]);
  // The same event again does nothing
  await copyIn(prefix, { 'notes.txt': Buffer.from('a note') });
  assert.equal((await call('GET', '/files?folder=Imported')).body.total, 3);
});

test('a file in someone else’s prefix, or an unknown batch, is ignored; a batch is its maker’s to see', async () => {
  const b = (await call('POST', '/batches', { drawer: 'mine' })).body;
  await copyIn(`incoming/${AMBER}/${b.id}/`, { 'x.txt': Buffer.from('not hers to send here') });
  await copyIn(`incoming/${LUKE}/b0000000000000099/`, { 'y.txt': Buffer.from('no batch') });
  assert.equal((await call('GET', '/files')).body.total, 0);
  assert.equal((await call('GET', `/batches/${b.id}`, undefined, token(AMBER))).status, 404);
});

test('Claude Code (a borrowed token) may start a batch: it’s in the manifest', async () => {
  assert.equal((await call('POST', '/batches', { drawer: 'mine' }, borrowed())).status, 200);
});

test('paths become folders: cleaned, and deeper than 8 levels kept flat at the eighth', () => {
  assert.deepEqual(placeOf('Imported', 'a/b/c.pdf'), { folder: 'Imported/a/b', name: 'c.pdf' });
  assert.deepEqual(placeOf('', 'c.pdf'), { folder: '', name: 'c.pdf' });
  assert.equal(placeOf('A', '1/2/3/4/5/6/7/8/9/x.txt').folder, 'A/1/2/3/4/5/6/7 - 8 - 9');
  assert.throws(() => placeOf('', 'a/../b.txt'));
});
