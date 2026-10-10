// Dot by text. The SMS webhook (tools/sms/api/webhook.mjs) has already checked Twilio's
// signature, that the number is opted in, and that it belongs to a family_assistant member; it
// invokes this function asynchronously (only its role may) with
//   { userId, username, phone, text, messageSid }
// Here Dot runs one turn as that person, exactly as on the web, and texts the reply back.
// A texting conversation carries on while it's active and starts over after a quiet spell, so a
// question tomorrow doesn't drag today's thread (and its cost) along.
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { runTurn } from './agent.mjs';
import { errorMessage, liveDeps } from './handler.mjs';
import { maskPhone, sendText, twilioConfig } from './twilio.mjs';

export const QUIET_HOURS = 6;
const MAX_TEXT = 1500; // Twilio's limit is 1,600 characters per message
const MAX_TEXTS = 3;

/** The latest texting conversation, if it was active in the last QUIET_HOURS */
export async function currentConversation(store, userId, now) {
  const recent = (await store.listConversations(userId)).find((c) => c.channel === 'sms');
  return recent && now - new Date(recent.updatedAt) < QUIET_HOURS * 3600e3 ? recent.id : undefined;
}

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

/** deps: what liveDeps() returns, plus text(to, body) */
export function createSmsWorker(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;
  return async (event) => {
    deps ??= depsOrFactory();
    const { userId, username, phone, text } = event;
    if (!userId || !/^\+1\d{10}$/.test(phone || '') || typeof text !== 'string' || !text.trim()) {
      console.error('bad event', Object.keys(event || {}));
      return;
    }
    const now = deps.now ? deps.now() : new Date();
    let reply;
    try {
      const forUser = deps.forUser ? await deps.forUser({ sub: userId, username }, 'sms') : {};
      const r = await runTurn({
        ...deps, ...forUser, fallbackState: new BetaFallbackState(), userId, channel: 'sms', text: text.trim(),
        conversationId: await currentConversation(deps.store, userId, now),
      });
      reply = r.text.trim() || (r.stopReason === 'refusal' ? 'Dot declined to answer that one.' : 'Dot had no answer for that. Try asking another way.');
    } catch (e) {
      console.error('turn failed', e);
      reply = errorMessage(e);
    }
    for (const body of toTexts(reply)) await deps.text(phone, body);
    console.log('replied', maskPhone(phone), event.messageSid);
  };
}

function liveSmsDeps(env = process.env) {
  const ssm = new SSMClient({});
  const twilio = twilioConfig(async () => (await ssm.send(new GetParameterCommand({ Name: env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value);
  return { ...liveDeps(env), text: async (to, body) => sendText(await twilio(), to, body) };
}

export const handler = createSmsWorker(() => liveSmsDeps());
