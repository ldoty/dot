// Bulk uploads: runs when a file lands in incoming/<sub>/<batchId>/<path> (S3 ObjectCreated), put there
// with the hour's credentials POST /batches handed out. It doesn't open the file: it hashes it (or takes
// the SHA-256 S3 already verified, when the upload sent one), registers it through the archive's own code
// as the batch's maker (POST /uploads: their drawer access, duplicates only where they can see), and
// copies it to f/<id>, where intake checks it and reads its text like any upload. Its subfolders become
// folders under the batch's folder. incoming/ empties itself after two days (the bucket's lifecycle).
// Rows: B#<batchId> / <path>  { status: 'filed' | 'duplicate' | 'refused', id?, why? }
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, CopyObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { cleanFolder, cleanName, liveApi } from './api.mjs';

const KEY = /^incoming\/([0-9a-f-]{36})\/(b[a-z0-9]{16})\/(.+)$/;

/** "Taxes/2025/1099.pdf" under "Imported" -> { folder: 'Imported/Taxes/2025', name: '1099.pdf' }, deeper than 8 kept flat at 8 */
export function placeOf(base, path) {
  const parts = path.split('/').filter(Boolean);
  const name = cleanName(parts.pop());
  const dirs = [...(base ? base.split('/') : []), ...parts];
  const folder = cleanFolder(dirs.length > 8 ? [...dirs.slice(0, 7), dirs.slice(7).join(' - ')].join('/') : dirs.join('/'));
  return { folder, name };
}

/** deps: archive (createApi's handler, with .as), db, table, s3: { head(key), hash(key) -> hex, copy(from, to, { type }) }, log? */
export function createBulk(deps) {
  const { archive, db, table, s3 } = deps;
  const log = deps.log ?? ((x) => console.log(JSON.stringify(x)));
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  const record = (batch, path, row) => db.send(new PutCommand({ TableName: table, Item: { pk: `B#${batch}`, sk: path.slice(0, 1000), ...row } }));

  async function one(key) {
    const m = KEY.exec(key);
    if (!m) return log({ bulk: 'ignored', key: key.slice(0, 80) });
    const [, sub, batchId, path] = m;
    const batch = await get('BATCH', batchId);
    // Only the batch's maker's prefix: the credentials couldn't write anywhere else, and this checks again
    if (!batch || batch.sub !== sub) return log({ bulk: 'no such batch', batch: batchId });
    if (await get(`B#${batchId}`, path.slice(0, 1000))) return log({ bulk: 'already done', batch: batchId });
    let place;
    try {
      place = placeOf(batch.folder, path);
    } catch (e) {
      return record(batchId, path, { status: 'refused', why: e.message });
    }
    const head = await s3.head(key);
    const sha256 = head.sha256b64 ? Buffer.from(head.sha256b64, 'base64').toString('hex') : await s3.hash(key);
    const person = { sub, username: batch.username };
    const r = await archive.as(person, {
      routeKey: 'POST /uploads',
      body: JSON.stringify({ drawer: batch.drawer, folder: place.folder, files: [{ name: place.name, size: head.size, sha256, type: head.type }] }),
    });
    const out = JSON.parse(r.body);
    if (r.statusCode !== 200) return record(batchId, path, { status: 'refused', why: out.error });
    const f = out.files[0];
    if (f.status === 'duplicate') return record(batchId, path, { status: 'duplicate', id: f.id });
    // Into the archive; the copy's own SHA-256 is what intake checks against the row
    await s3.copy(key, `f/${f.id}`, { type: head.type });
    await record(batchId, path, { status: 'filed', id: f.id });
    log({ bulk: 'filed', batch: batchId, id: f.id });
  }

  return async (event) => {
    for (const r of event.Records ?? []) {
      const key = decodeURIComponent(String(r.s3?.object?.key ?? '').replace(/\+/g, ' '));
      try {
        await one(key);
      } catch (e) {
        console.error('bulk failed', key.slice(0, 120), e);
      }
    }
  };
}

let live;
export const handler = async (event) => (live ??= (() => {
  const s3 = new S3Client({});
  const Bucket = process.env.BUCKET;
  return createBulk({
    archive: liveApi(),
    db: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    table: process.env.TABLE,
    s3: {
      head: async (Key) => {
        const h = await s3.send(new HeadObjectCommand({ Bucket, Key, ChecksumMode: 'ENABLED' }));
        // A checksum of parts (multipart, "…-12") isn't the file's own SHA-256
        const whole = h.ChecksumSHA256 && !h.ChecksumSHA256.includes('-') && h.ChecksumType !== 'COMPOSITE' ? h.ChecksumSHA256 : null;
        return { size: h.ContentLength, sha256b64: whole, type: h.ContentType || 'application/octet-stream' };
      },
      hash: async (Key) => {
        const body = (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body;
        const h = createHash('sha256');
        for await (const chunk of body) h.update(chunk);
        return h.digest('hex');
      },
      copy: (from, to, { type }) => s3.send(new CopyObjectCommand({
        Bucket, Key: to, CopySource: `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        ContentType: type, MetadataDirective: 'REPLACE', ChecksumAlgorithm: 'SHA256',
      })),
    },
  });
})())(event);
