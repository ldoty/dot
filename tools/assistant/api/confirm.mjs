// Confirmations that only the person can give. When a tool answers that something needs their OK
// (House's `confirm` grants, deleting a list), the tool result records it with MARK; Claude never
// gets a field to pass the tool's confirmation id back. A later call with confirm: true goes ahead
// only if the person has written a new message since: a hidden instruction in an email, invite or
// tool answer can't approve its own request within the turn it arrived in. Tool results never count
// as their reply, and neither does a scheduled ask's own message.

export const MARK = 'needs_confirmation';
// A scheduled ask's run (scheduled.mjs) starts its message with this. It's written by Dot's own code,
// not by the person, so it never counts as their reply.
export const SCHEDULED_MARK = '[Scheduled ask';
const theirOwn = (m) => m.role === 'user' && m.content.some((c) => c.type === 'image' || (c.type === 'text' && !c.text.startsWith(SCHEDULED_MARK)))
  && !m.content.some((c) => c.type === 'text' && c.text.startsWith(SCHEDULED_MARK));

/** The tool result that asks: what the person should be asked, and what to send once they agree */
export const asking = (tool, fields) => JSON.stringify({ [MARK]: true, tool, ...fields });

/**
 * The latest confirmation `tool` asked for in the history that `fits` (what the confirming call names), and
 * whether the person has written since. Every ask is kept, not just the last: when Dot asks about several
 * changes at once (two events to delete), one reply confirms each of them. Each tool's own confirmation
 * is still single use and short-lived, so an old ask can't be confirmed twice.
 */
export function pendingIn(history, tool, fits = () => true) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || typeof b.content !== 'string' || !b.content.includes(MARK)) continue;
      let p;
      try { p = JSON.parse(b.content); } catch { continue; }
      if (!p[MARK] || p.tool !== tool || !fits(p)) continue;
      // The person's own words come in a user message that isn't only tool results
      const answered = history.slice(i + 1).some(theirOwn);
      return { ...p, answered };
    }
  }
  return null;
}
