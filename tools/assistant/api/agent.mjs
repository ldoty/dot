// One conversation turn, independent of how it was delivered: the web page streams it,
// and a phone channel can run the same turn and send back the final text.
//
//   runTurn({ ...deps, userId, conversationId?, text, channel?, onEvent? })
//     -> { conversationId, text, stopReason }
//   onEvent receives { type: 'conversation' | 'text' | 'tool' | 'error' , ... } as the turn runs.

export const SYSTEM_PROMPT = `You are Luke's personal assistant. He reaches you from a private web page, and later by phone, so keep replies short and plain; he is often on his phone.

You can read and change Google calendars with your tools. Call list_calendars if you need the calendars' names. Times are in the calendar's time zone unless Luke says otherwise, and each of Luke's messages begins with the current date and time in brackets, so resolve "tomorrow" or "next Friday" from that.

Before creating an event, make sure you know which calendar, the title, the day and the time; ask if one of those is missing rather than guessing. Confirm with Luke before deleting an event, or before changing one you didn't create (created_by_assistant is false). After any change, say exactly what you did: calendar, title, day and time.`;

const MAX_STEPS = 12;

/** "[Fri, Oct 2, 2026, 4:45 PM EDT]" */
export function stamp(now, timeZone) {
  return `[${new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(now)}]`;
}

const uid = () => 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** The request copy gets a cache breakpoint on its last block; stored history is never touched */
function withCacheBreakpoint(messages) {
  const out = messages.slice();
  const last = out[out.length - 1];
  const content = last.content.slice();
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  out[out.length - 1] = { ...last, content };
  return out;
}

export async function runTurn({
  client, store, tools, model, fallbackState, timeZone, now = () => new Date(), log = () => {},
  userId, conversationId, text, channel = 'web', onEvent = () => {}, effort = 'low',
}) {
  let conv = conversationId ? await store.getConversation(userId, conversationId) : null;
  if (conversationId && !conv) throw Object.assign(new Error('No such conversation'), { status: 404 });
  if (!conv) conv = await store.createConversation(userId, { id: uid(), title: text.trim().slice(0, 60), channel, now: now() });
  onEvent({ type: 'conversation', id: conv.id, title: conv.title });

  const history = await store.loadMessages(userId, conv.id);
  const append = async (message) => {
    await store.appendMessage(userId, conv.id, history.length, message, now());
    history.push(message);
  };
  await append({ role: 'user', content: [{ type: 'text', text: stamp(now(), timeZone) }, { type: 'text', text }] });

  let reply = '', stopReason = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      output_config: { effort },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: tools.definitions,
      messages: withCacheBreakpoint(history),
    }, { fallbackState });
    stream.on('text', (delta) => { reply += delta; onEvent({ type: 'text', delta }); });
    const message = await stream.finalMessage();
    stopReason = message.stop_reason;
    log({ model: message.model, stop_reason: stopReason, usage: message.usage });

    await append({ role: 'assistant', content: message.content });

    if (stopReason === 'refusal') {
      onEvent({ type: 'error', message: 'Claude declined to answer that one.' });
      break;
    }
    if (stopReason === 'pause_turn') continue;
    const uses = message.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;
    if (stopReason === 'max_tokens') {
      // A tool call cut off mid-input must not run; answer it so the history stays valid
      await append({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Cut off before the input was complete.' })) });
      onEvent({ type: 'error', message: 'That reply ran too long and was cut off.' });
      break;
    }

    for (const u of uses) onEvent({ type: 'tool', name: u.name, status: 'running' });
    const results = await Promise.all(uses.map((u) => tools.run(u)));
    results.forEach((r, i) => onEvent({ type: 'tool', name: uses[i].name, status: r.is_error ? 'error' : 'done' }));
    await append({ role: 'user', content: results });

    if (step === MAX_STEPS - 1) onEvent({ type: 'error', message: 'Stopped after too many steps. Ask again to continue.' });
  }
  return { conversationId: conv.id, text: reply, stopReason };
}

/** What the page shows for a stored conversation: your messages, replies, and which tools ran */
export function toTranscript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const texts = m.content.filter((b) => b.type === 'text');
      if (texts.length) out.push({ role: 'user', text: texts[texts.length - 1].text });
      continue;
    }
    const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const tools = m.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
    const prev = out[out.length - 1];
    if (prev?.role === 'assistant') {
      prev.text += text;
      prev.tools.push(...tools);
    } else out.push({ role: 'assistant', text, tools });
  }
  return out;
}
