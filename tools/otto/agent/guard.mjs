// A managed PreToolUse hook (managed-settings.json), for what an allowlist can't say: which labels a
// tool may remove. Claude Code passes the call as JSON on stdin; exit 2 refuses it, with stderr as why.
// A clear run (OTTO_SOURCE=clear, set by otto.mjs) may remove UNREAD and Luke's own labels (Label_…),
// so it marks read but never archives (INBOX), unstars or touches any other system label.
import { readFileSync } from 'node:fs';

export const CLEAR_REMOVABLE = /^(UNREAD|Label_\d+)$/;

/** null if the call may go ahead, else why not */
export function refuse(call, source) {
  if (source !== 'clear') return null;
  const tool = String(call.tool_name ?? '');
  if (/__(search_threads|list_labels)$/.test(tool)) return null;
  if (!/__unlabel_thread$/.test(tool)) return `a clear run can’t use ${tool}`;
  const ids = call.tool_input?.labelIds;
  if (!Array.isArray(ids) || !ids.length) return 'no labels named';
  const bad = ids.filter((l) => !CLEAR_REMOVABLE.test(String(l)));
  return bad.length ? `a clear run may only remove UNREAD and Otto/Clear, not ${bad.join(', ')}` : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let why;
  try {
    why = refuse(JSON.parse(readFileSync(0, 'utf8')), process.env.OTTO_SOURCE);
  } catch {
    why = 'unreadable tool call';
  }
  if (why) {
    process.stderr.write(why);
    process.exit(2);
  }
}
