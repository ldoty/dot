// Confirmations that only the person can give. When a tool answers that something needs their OK
// (House's `confirm` grants, deleting a list), the tool result records it with MARK; Claude never
// gets a field to pass the tool's confirmation id back. A later call with confirm: true goes ahead
// only if the person has written a new message since: a hidden instruction in an email, invite or
// tool answer can't approve its own request within the turn it arrived in. Tool results never count
// as their reply.

export const MARK = 'needs_confirmation';

/** The tool result that asks: what the person should be asked, and what to send once they agree */
export const asking = (tool, fields) => JSON.stringify({ [MARK]: true, tool, ...fields });

/** The latest confirmation `tool` asked for in the history, and whether the person has written since */
export function pendingIn(history, tool) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || typeof b.content !== 'string' || !b.content.includes(MARK)) continue;
      let p;
      try { p = JSON.parse(b.content); } catch { continue; }
      if (!p[MARK] || p.tool !== tool) continue;
      // The person's own words come in a user message that isn't only tool results
      const answered = history.slice(i + 1).some((n) => n.role === 'user' && n.content.some((c) => c.type === 'text' || c.type === 'image'));
      return { ...p, answered };
    }
  }
  return null;
}
