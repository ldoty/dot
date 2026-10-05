// Files transactions under budget lines.
//   1. Your corrections: once you move a merchant's transaction to a line, that merchant's
//      transactions go there from then on (rules, keyed by merchantKey).
//   2. Claude, for the rest: it sees the budget's lines and picks one per transaction, or none.
// Anything left over stays unassigned for you to file on the page.

/** "SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA" -> "SQ BLUE BOTTLE COFFEE": what a rule matches on */
export function merchantKey(text) {
  return String(text || '').toUpperCase()
    .replace(/[^A-Z&' ]+/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1 || w === '&').slice(0, 4).join(' ')
    .trim();
}

const ASSIGN_TOOL = {
  name: 'assign',
  description: 'File each transaction under one budget line id, or "" when no line fits or you are unsure.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'line'],
          properties: { id: { type: 'string' }, line: { type: 'string' } },
        },
      },
    },
  },
};

const SYSTEM = `You file a person's bank and card transactions under the lines of their household budget.
Amounts are signed: negative is money out, positive is money in.
Pick the single line that best fits each transaction, by merchant and amount. "income" lines take money in (pay, refunds of income); "spend" and "save" lines take money out; the "skip" line (Transfers) is for money moving between their own accounts: paying a credit card ("payment thank you", "autopay", "payment to card"), "online transfer to/from", moving money to savings or another of their accounts. A transfer is never income and never spending. Lines in the "Shared" group are household costs they pay part of.
Each category has a "General" line: use it when you're sure of the category but no one line in it clearly fits.
Use "" when nothing fits or you aren't reasonably sure even of the category: they'll file it themselves, and a wrong guess is worse than none.
Answer by calling the assign tool once, with every transaction id.`;

/**
 * Asks Claude to file `txns` ({ id, date, amount, description, account }) under `lines`.
 * Returns Map id -> line id. Unknown ids and lines are dropped. Batches of 100.
 */
export async function classify({ client, model, lines, txns, log = () => {} }) {
  const out = new Map();
  if (!txns.length || !lines.length) return out;
  const valid = new Set(lines.map((l) => l.id));
  const lineList = lines.map((l) => `${l.id}\t${l.kind}\t${l.group} › ${l.category} › ${l.name}`).join('\n');
  for (let i = 0; i < txns.length; i += 100) {
    const batch = txns.slice(i, i + 100);
    const ids = new Set(batch.map((t) => t.id));
    const rows = batch.map((t) => `${t.id}\t${t.date}\t${t.amount}\t${t.account}\t${t.description}`).join('\n');
    const msg = await client.messages.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [ASSIGN_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{
        role: 'user',
        content: `Budget lines (id, kind, group › category › name):\n${lineList}\n\nTransactions (id, date, amount, account, description):\n${rows}`,
      }],
    });
    log({ model: msg.model, stop_reason: msg.stop_reason, usage: msg.usage, batch: batch.length });
    if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') continue;
    const use = msg.content.find((b) => b.type === 'tool_use' && b.name === 'assign');
    for (const a of use?.input?.assignments || []) {
      if (ids.has(a.id) && valid.has(a.line)) out.set(a.id, a.line);
    }
  }
  return out;
}
