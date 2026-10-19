// Dot by text. The SMS webhook (tools/sms/api/webhook.mjs) has already checked Twilio's
// signature, that the number is opted in, and that it belongs to a family_assistant member; it
// invokes this function asynchronously (only its role may) with
//   { userId, username, phone, text, media: [{ url, type }], skipped, messageSid }
// Here Dot runs one turn as that person, exactly as on the web, and texts the reply back.
// Photos are downloaded from Twilio and deleted there; Dot's photo bucket keeps them for a week (store.mjs).
// A texting conversation carries on while it's active and starts over after a quiet spell, so a
// question tomorrow doesn't drag today's thread (and its cost) along.
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { runTurn } from './agent.mjs';
import { sentSince } from './automations.mjs';
import { errorMessage, liveDeps } from './handler.mjs';
import { deleteMedia, fetchMedia, maskPhone, sendText, twilioConfig } from './twilio.mjs';

export const QUIET_HOURS = 6;
const MAX_TEXT = 1500; // Twilio's limit is 1,600 characters per message
const MAX_TEXTS = 3;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_750_000; // Bedrock's limit for one image
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * The photos as Claude image blocks' sources, and how many couldn't be used. Each is deleted from
 * Twilio once it's been tried, opened or not; a failed delete is logged and doesn't stop the turn.
 */
export async function loadImages(media, { fetchMedia: get, deleteMedia: remove }) {
  const images = [];
  let failed = 0;
  for (const m of media.slice(0, MAX_IMAGES)) {
    try {
      const { type, bytes } = await get(m.url, MAX_IMAGE_BYTES);
      if (!IMAGE_TYPES.includes(type)) throw new Error(`not an image Claude can read (${type})`);
      images.push({ media_type: type, data: bytes.toString('base64') });
    } catch (e) {
      console.warn('photo not used:', e.message);
      failed++;
    }
    await remove(m.url).catch((e) => console.error('photo not deleted from Twilio', e.message));
  }
  return { images, failed: failed + Math.max(0, media.length - MAX_IMAGES) };
}

/** The latest texting conversation (the whole record), if it was active in the last QUIET_HOURS */
export async function latestConversation(store, userId, now) {
  const recent = (await store.listConversations(userId)).find((c) => c.channel === 'sms');
  return recent && now - new Date(recent.updatedAt) < QUIET_HOURS * 3600e3 ? recent : undefined;
}

/** The latest texting conversation's id, if it was active in the last QUIET_HOURS */
export const currentConversation = async (store, userId, now) => (await latestConversation(store, userId, now))?.id;


/**
 * A reply as texts: Markdown Claude slipped in is flattened, long replies split at a break, and
 * no links: the campaign is registered without embedded links, so web addresses never go out.
 */
export function toTexts(reply) {
  const plain = reply
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[*]\s+/gm, '- ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(?<![\w@.-])(https?:\/\/)?([\w-]+\.)*dot-y\.co\b(\/([^\s)]*[^\s).,!?])?)?/gi, 'the family site')
    .replace(/https?:\/\/[^\s)]*[^\s).,!?]/gi, '(link left out)')
    .replace(/\n{3,}/g, '\n\n').trim();
  const texts = [];
  let rest = plain;
  while (rest && texts.length < MAX_TEXTS) {
    if (rest.length <= MAX_TEXT) { texts.push(rest); rest = ''; break; }
    const head = rest.slice(0, MAX_TEXT);
    const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf('. ') + 1, head.lastIndexOf(' ')]
      .find((i) => i > MAX_TEXT / 2) ?? MAX_TEXT;
    texts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) texts[texts.length - 1] = texts[texts.length - 1].slice(0, MAX_TEXT - 40).trimEnd() + '… (The rest is on the Dot page.)';
  return texts;
}

/** deps: what liveDeps() returns, plus text(to, body), fetchMedia(url, maxBytes) -> { type, bytes } and deleteMedia(url) */
export function createSmsWorker(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;
  return async (event) => {
    deps ??= depsOrFactory();
    const { userId, username, phone, text, media = [], skipped = 0 } = event;
    if (!userId || !/^\+1\d{10}$/.test(phone || '') || typeof text !== 'string' || !Array.isArray(media) || !(text.trim() || media.length)) {
      console.error('bad event', Object.keys(event || {}));
      return;
    }
    const now = deps.now ? deps.now() : new Date();
    // loadImages never throws: a photo that can't be opened is counted instead
    const { images, failed } = await loadImages(media, deps);
    const missed = failed + (Number.isInteger(skipped) ? skipped : 0);
    // Tell Dot what didn't come through, so it can say so instead of answering as if it saw everything
    const note = missed ? `[${missed} attachment${missed > 1 ? 's' : ''} couldn’t be opened]` : '';
    const said = [text.trim(), note].filter(Boolean).join('\n\n');
    let reply = 'Dot couldn’t open that photo. Try sending it again.';
    if (images.length || text.trim()) {
      try {
        const forUser = deps.forUser ? await deps.forUser({ sub: userId, username }, 'sms') : {};
        const conv = await latestConversation(deps.store, userId, now);
        const r = await runTurn({
          ...deps, ...forUser, fallbackState: new BetaFallbackState(), userId, channel: 'sms', text: said, images,
          conversationId: conv?.id, sent: await sentSince(forUser, conv?.updatedAt, now, deps.timeZone),
        });
        reply = r.text.trim() || (r.stopReason === 'refusal' ? 'Dot declined to answer that one.' : 'Dot had no answer for that. Try asking another way.');
      } catch (e) {
        console.error('turn failed', e);
        reply = errorMessage(e);
      }
    }
    for (const body of toTexts(reply)) await deps.text(phone, body);
    console.log('replied', maskPhone(phone), event.messageSid);
  };
}

function liveSmsDeps(env = process.env) {
  const ssm = new SSMClient({});
  const twilio = twilioConfig(async () => (await ssm.send(new GetParameterCommand({ Name: env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value);
  return {
    ...liveDeps(env),
    text: async (to, body) => sendText(await twilio(), to, body),
    fetchMedia: async (url, maxBytes) => fetchMedia(await twilio(), url, { maxBytes }),
    deleteMedia: async (url) => deleteMedia(await twilio(), url),
  };
}

export const handler = createSmsWorker(() => liveSmsDeps());
