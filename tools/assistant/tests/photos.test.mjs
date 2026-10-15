// Photos texted or emailed in: kept in the photo store for PHOTO_DAYS, shown again on later turns
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, PHOTO_DAYS, MAX_PHOTOS_SHOWN } from '../api/store.mjs';
import { s3Photos } from '../api/handler.mjs';
import { toTranscript } from '../api/agent.mjs';
import { db, fakePhotos, NOW, table } from './helpers/deps.mjs';

const USER = 'luke-sub';
let photos, store;
beforeEach(() => { table.clear(); photos = fakePhotos(); store = makeStore({ db, table: 'lukes-assistant', photos }); });

const image = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
const at = (days) => new Date(NOW.getTime() - days * 86400e3);
async function conversation(messages) {
  await store.createConversation(USER, { id: 'c1', title: 'Photo', channel: 'sms', now: NOW });
  for (const [i, [content, when]] of messages.entries()) await store.appendMessage(USER, 'c1', i, { role: i % 2 ? 'assistant' : 'user', content }, when, 'sms');
}

test('a photo is stored outside the table and comes back while it’s kept', async () => {
  await conversation([[[{ type: 'text', text: '[stamp]' }, image('AAAA'), { type: 'text', text: 'Add this' }], NOW]]);
  assert.deepEqual([...photos.kept.keys()], [`${USER}/c1/000000-1`]);
  assert.ok(!JSON.stringify(table.dump()).includes('AAAA'));
  const [m] = await store.loadMessages(USER, 'c1', { now: NOW });
  assert.deepEqual(m.content[1], image('AAAA'));
});

test(`after ${PHOTO_DAYS} days, or once the bucket has deleted it, a photo is a note`, async () => {
  await conversation([[[image('OLD')], at(PHOTO_DAYS + 0.01)], [[{ type: 'text', text: 'ok' }], NOW], [[image('GONE')], NOW]]);
  photos.kept.delete(`${USER}/c1/000002-0`);
  const msgs = await store.loadMessages(USER, 'c1', { now: NOW });
  assert.deepEqual([msgs[0].content[0], msgs[2].content[0]], [{ type: 'text', text: '[Photo, no longer kept]' }, { type: 'text', text: '[Photo, no longer kept]' }]);
  assert.equal(photos.gets, 1, 'an expired photo isn’t even fetched');
});

test(`only the newest ${MAX_PHOTOS_SHOWN} photos go back to Claude`, async () => {
  const n = MAX_PHOTOS_SHOWN + 2;
  await conversation([[Array.from({ length: n }, (_, i) => image(`P${i}`)), NOW]]);
  const [m] = await store.loadMessages(USER, 'c1', { now: NOW });
  assert.deepEqual(m.content.map((b) => b.source?.data ?? b.text), ['[Photo, no longer kept]', '[Photo, no longer kept]', ...Array.from({ length: MAX_PHOTOS_SHOWN }, (_, i) => `P${i + 2}`)]);
});

test('the page’s transcript says [Photo] without fetching anything', async () => {
  await conversation([[[{ type: 'text', text: '[stamp]' }, image('AAAA')], NOW]]);
  const msgs = await store.loadMessages(USER, 'c1', { photos: false });
  assert.deepEqual(toTranscript(msgs), [{ role: 'user', text: '[Photo]' }]);
  assert.equal(photos.gets, 0);
});

test('deleting a conversation deletes its photos', async () => {
  await conversation([[[image('AAAA'), image('BBBB')], NOW]]);
  await store.deleteConversation(USER, 'c1');
  assert.equal(photos.kept.size, 0);
});

test('without a photo store, photos aren’t kept at all', async () => {
  store = makeStore({ db, table: 'lukes-assistant' });
  await conversation([[[image('AAAA')], NOW]]);
  assert.deepEqual((await store.loadMessages(USER, 'c1'))[0].content, [{ type: 'text', text: '[Photo, not kept]' }]);
});

test('S3 photo store: puts bytes with their type, reads them back, and a deleted one is null', async () => {
  const objects = new Map();
  const s3 = {
    async send(cmd) {
      const { Bucket, Key, Body, ContentType } = cmd.input;
      assert.equal(Bucket, 'photos-bucket');
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') return objects.set(Key, { Body, ContentType });
      if (name === 'DeleteObjectCommand') return objects.delete(Key);
      const o = objects.get(Key);
      if (!o) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { ContentType: o.ContentType, Body: { transformToByteArray: async () => new Uint8Array(o.Body) } };
    },
  };
  const p = s3Photos('photos-bucket', s3);
  await p.put('k', { media_type: 'image/png', data: Buffer.from('png!').toString('base64') });
  assert.ok(Buffer.isBuffer(objects.get('k').Body), 'stored as bytes, not base64 text');
  assert.deepEqual(await p.get('k'), { media_type: 'image/png', data: Buffer.from('png!').toString('base64') });
  await p.remove('k');
  assert.equal(await p.get('k'), null);
});
