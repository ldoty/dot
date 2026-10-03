// A scripted stand-in for the Anthropic client's beta.messages.stream(). Each call returns the
// next scripted response; requests are recorded exactly as sent (deep-copied) for assertions.
export function fakeClaude(script) {
  const calls = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(params, options) {
          calls.push({ params: structuredClone(params), options });
          const reply = typeof script[i] === 'function' ? script[i](params) : script[i];
          i++;
          if (!reply) throw new Error(`fake Claude: no scripted response for call ${i}`);
          const listeners = [];
          return {
            on(event, fn) { if (event === 'text') listeners.push(fn); return this; },
            async finalMessage() {
              for (const block of reply.content) {
                if (block.type === 'text') for (const piece of block.text.match(/.{1,8}/gs) || []) listeners.forEach((fn) => fn(piece));
              }
              return { model: 'anthropic.claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn', ...reply };
            },
          };
        },
      },
    },
  };
  return { client, calls, remaining: () => script.length - i };
}

export const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
export const toolUse = (name, input, id = `tu_${name}`, extra = []) => ({
  content: [...extra, { type: 'tool_use', id, name, input }], stop_reason: 'tool_use',
});
