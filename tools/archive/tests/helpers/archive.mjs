// The real archive handler and intake on an in-memory table and bucket, called the way API Gateway and
// S3 call them, with the family's groups on the same table (as platform/family stores them).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';
import { makePeople } from '../../api/people.mjs';
import { createApi } from '../../api/api.mjs';
import { createIntake } from '../../api/intake.mjs';

export const CLIENT_ID = 'archive-client', DELEGATED = 'archive-via-dot';
export const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
export const AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07';
export const table = fakeTable({ pageSize: 2 }); // everything must follow pages
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

/** The bucket: what was uploaded (as S3 would hold it after a checked PUT) and what intake wrote */
export const bucket = new Map();
let n = 0;
export const archiveApi = createApi({
  db, table: 'family-archive', group: 'family_archive', issuer: ISSUER, clientId: CLIENT_ID, delegatedClientId: DELEGATED,
  people: makePeople({ db, table: 'family-people', ttlMs: 0 }),
  members: async () => [{ sub: LUKE, name: 'Luke' }, { sub: AMBER, name: 'amber@x.test' }],
  newId: () => `f${String(++n).padStart(16, '0')}`,
  files: {
    putUrl: async ({ key, size, sha256 }) => `https://s3.test/${key}?size=${size}&sha=${sha256}`,
    getUrl: async ({ key, name }) => `https://s3.test/${key}?download=${encodeURIComponent(name)}`,
    text: async (key) => bucket.get(key)?.toString() ?? null,
    remove: async (key) => { bucket.delete(key); },
  },
});
export const intake = createIntake({
  db, table: 'family-archive',
  s3: {
    head: async (key) => ({ size: bucket.get(key).length, sha256b64: createHash('sha256').update(bucket.get(key)).digest('base64') }),
    get: async (key) => bucket.get(key),
    putText: async (key, text) => bucket.set(key, Buffer.from(text)),
  },
});
export const ROUTES = [
  'GET /dot', 'GET /drawers', 'PUT /drawers/{id}', 'GET /files', 'GET /files/{id}', 'GET /files/{id}/text', 'GET /files/{id}/download',
  'POST /uploads', 'PATCH /files/{id}', 'PUT /files/{id}/links/{to}', 'DELETE /files/{id}/links/{to}', 'DELETE /files/{id}', 'GET /share-options',
];
export const token = (sub = LUKE) => accessToken({ clientId: CLIENT_ID, group: 'family_archive', sub, username: sub });
/** A token Claude Code (or Dot) borrowed for this person */
export const borrowed = (sub = LUKE) => accessToken({ clientId: DELEGATED, group: 'family_archive', sub, username: sub, via: 'dot' });
const callApi = caller(archiveApi, ROUTES);
export const call = (method, path, body, t = token()) => callApi(method, path, body, t);
export const familyGroup = (id, name, members) => table.put({ pk: 'GROUP', sk: id, name, members, rev: 1 });
export const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Upload files the way a client does: ask, PUT the bytes (into the fake bucket), intake runs. -> the upload answer */
export async function upload(drawer, folder, docs, t = token()) {
  const r = await call('POST', '/uploads', {
    drawer, folder, files: docs.map((d) => ({ name: d.name, size: d.bytes.length, sha256: sha(d.bytes), type: d.type })),
  }, t);
  if (r.status !== 200) return r;
  for (const [i, f] of r.body.files.entries()) {
    if (f.status !== 'upload') continue;
    bucket.set(`f/${f.id}`, docs[i].bytes);
    await intake({ Records: [{ s3: { object: { key: `f/${f.id}` } } }] });
  }
  return r;
}
export function reset() {
  table.clear();
  bucket.clear();
}
