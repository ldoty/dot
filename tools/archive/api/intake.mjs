// Intake: runs when a file lands in the bucket (S3 ObjectCreated on f/), with no Claude in it. For each:
//   1. find its row (it must be 'uploading': a second event for the same file does nothing),
//   2. check S3 has what the upload promised: the size, and the SHA-256 S3 itself verified on the PUT,
//   3. read its text (PDFs with unpdf, text files as UTF-8; scans and photos have none) into text/<id>.txt,
//   4. file it: status 'filed', and note its bytes (H#<sha256>) so the next upload finds the duplicate.
// The file is untrusted, so this is the riskiest code in the tool: its role may read f/, write text/ and
// write rows, nothing else (no Bedrock, no mail, never a delete). A file whose text can't be read is
// still filed, without text; one that isn't what was promised is marked 'rejected' and never shown.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_TEXT = 2_000_000; // characters kept; the rest of a huge document isn't searched
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml))/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|eml|ics|vcf)$/i;

/** What text a file holds: { text, pages? } (text '' for none) */
export async function readText({ bytes, type, name }) {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { text: String(text || '').trim().slice(0, MAX_TEXT), pages: totalPages };
  }
  if (TEXT_TYPES.test(type || '') || TEXT_NAMES.test(name || '')) {
    return { text: bytes.toString('utf8').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT) };
  }
  return { text: '' };
}

/** deps: db, table, s3: { head(key) -> { size, sha256b64 }, get(key) -> Buffer, putText(key, text) }, read?, now? */
export function createIntake(deps) {
  const { db, table, s3 } = deps;
  const read = deps.read ?? readText;
  const now = deps.now ?? (() => new Date());
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  const put = (Item, cond) => db.send(new PutCommand({ TableName: table, Item, ...cond }));

  async function one(key) {
    const id = /^f\/(f[a-z0-9]{16})$/.exec(key)?.[1];
    if (!id) return console.warn(JSON.stringify({ intake: 'ignored', key: key.slice(0, 80) }));
    const where = await get('FILE', id);
    const row = where && await get(`D#${where.drawer}`, `F#${id}`);
    if (!row || row.status !== 'uploading') return console.log(JSON.stringify({ intake: 'nothing to do', id }));
    const at = now().toISOString();
    const log = (action, detail) => put({ pk: `LOG#${where.drawer}`, sk: `${at}#${id}#intake`, by: 'intake', via: 'intake', action, ...(detail ? { detail } : {}) });

    const head = await s3.head(key);
    const promised = Buffer.from(row.sha256, 'hex').toString('base64');
    if (head.size !== row.size || head.sha256b64 !== promised) {
      await put({ ...row, status: 'rejected', rev: row.rev + 1, updatedAt: at }, { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev } });
      await log('rejected', { why: head.size !== row.size ? 'size' : 'checksum' });
      return console.warn(JSON.stringify({ intake: 'rejected', id }));
    }

    let found = { text: '' };
    try {
      found = await read({ bytes: await s3.get(key), type: row.type, name: row.name });
    } catch (e) {
      console.warn(JSON.stringify({ intake: 'no text', id, error: String(e.message).slice(0, 200) }));
    }
    if (found.text) await s3.putText(`text/${id}.txt`, found.text);

    const filed = {
      ...row, status: 'filed', hasText: !!found.text, textChars: found.text.length,
      ...(found.pages ? { pages: found.pages } : {}), rev: row.rev + 1, updatedAt: at,
    };
    await put(filed, { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev } });
    await put({ pk: `H#${row.sha256}`, sk: id, drawer: where.drawer });
    await log('filed', { text: found.text.length, ...(found.pages ? { pages: found.pages } : {}) });
    console.log(JSON.stringify({ intake: 'filed', id, text: found.text.length }));
  }

  return async (event) => {
    for (const r of event.Records ?? []) {
      // S3 event keys come URL-encoded, spaces as +
      await one(decodeURIComponent(String(r.s3?.object?.key ?? '').replace(/\+/g, ' ')));
    }
  };
}

let live;
export const handler = async (event) => (live ??= (() => {
  const s3 = new S3Client({});
  const Bucket = process.env.BUCKET;
  return createIntake({
    db: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    table: process.env.TABLE,
    s3: {
      head: async (Key) => {
        const h = await s3.send(new HeadObjectCommand({ Bucket, Key, ChecksumMode: 'ENABLED' }));
        return { size: h.ContentLength, sha256b64: h.ChecksumSHA256 };
      },
      get: async (Key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray()),
      putText: (Key, text) => s3.send(new PutObjectCommand({ Bucket, Key, Body: text, ContentType: 'text/plain; charset=utf-8' })),
    },
  });
})())(event);
