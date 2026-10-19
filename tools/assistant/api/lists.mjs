// Dot changing the family's lists, as the person asking. Reading is discovered like any tool
// (Lists' GET /dot manifest: lists_all, lists_list, lists_reminders); changing is this built-in,
// because discovered tools are GET only. Lists decides everything: Dot can change only lists the
// person may edit, and never who a list is shared with. Each call borrows a short-lived token for the
// asker (delegation.mjs) and is audited. Deleting a whole list needs the person's own OK (confirm.mjs).
import { asking, pendingIn } from './confirm.mjs';

export const ACTIONS = ['add_item', 'update_item', 'complete_item', 'reopen_item', 'delete_item', 'create_list', 'rename_list', 'set_layout', 'delete_list'];

export const definition = {
  name: 'lists_change',
  description: 'Lists: change the family’s lists as the person asking (only lists they can edit). Use lists_all and lists_list first for ids. '
    + 'add_item (list_id, text, and any of the item fields), update_item (list_id, item_id, only the fields to change), complete_item / reopen_item / delete_item '
    + '(list_id, item_id), create_list (name, layout?), rename_list (list_id, name), set_layout (list_id, layout), delete_list (list_id; it asks the person first, '
    + 'then call again with confirm: true only after they agree). A reminder is texted or emailed to the person at remind_at.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      list_id: { type: 'string' },
      item_id: { type: 'string' },
      text: { type: 'string', description: 'The item' },
      notes: { type: 'string' },
      due: { type: 'string', description: 'YYYY-MM-DD, or "" to clear' },
      urgent: { type: 'boolean', description: 'Matrix: urgent' },
      important: { type: 'boolean', description: 'Matrix: important' },
      column: { type: 'string', description: 'Board: one of the list’s columns' },
      remind_at: { type: 'string', description: 'Local time "YYYY-MM-DDTHH:MM" (their time zone), or "" to clear the reminder' },
      remind_by: { type: 'string', enum: ['sms', 'email'], description: 'Leave out to use how they usually get reminders' },
      name: { type: 'string', description: 'List name' },
      layout: { type: 'string', enum: ['checklist', 'matrix', 'board'] },
      confirm: { type: 'boolean', description: 'Only for delete_list, after the person agreed' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

/** "2026-10-20T09:00" in timeZone -> ISO (UTC), across DST */
export function zonedToIso(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? '');
  if (!m) throw new Error('remind_at: "YYYY-MM-DDTHH:MM" in their local time');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = wall - offset(wall);
  t = wall - offset(t); // once more, in case the first guess fell across a DST change
  return new Date(t).toISOString();
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ITEM_FIELDS = ['text', 'done', 'notes', 'due', 'urgent', 'important', 'column', 'order', 'assignee', 'remind'];

export function makeLists({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch, timeZone = 'America/New_York' }) {
  async function call(method, path, body) {
    let token;
    try {
      token = await tokenFor({ clientId, sub: user.sub, username: user.username, channel });
    } catch (e) {
      throw new Error(e.denied ? 'This person doesn’t have access to Lists.' : 'Couldn’t reach Lists right now.');
    }
    const res = await fetch(`${apiUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let out = {};
    try { out = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, out };
  }
  const fail = (r) => { throw new Error(r.status === 404 ? 'That list isn’t there, or isn’t shared with them.' : `Lists answered ${r.status}${r.out.error ? `: ${r.out.error}` : ''}`); };

  /** The item fields to send, from the tool's input */
  function changes(input) {
    const c = {};
    for (const k of ['text', 'notes', 'urgent', 'important', 'column']) if (input[k] !== undefined) c[k] = input[k];
    if (input.due !== undefined) c.due = input.due || null;
    if (input.remind_at !== undefined) c.remind = input.remind_at ? { at: zonedToIso(input.remind_at, timeZone), channel: input.remind_by ?? null } : null;
    return c;
  }
  /** Read-change-write one item, retrying once if someone else changed it meanwhile */
  async function changeItem(listId, itemId, patch) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await call('GET', `/lists/${listId}`);
      if (got.status !== 200) fail(got);
      const item = got.out.items.find((i) => i.id === itemId);
      if (!item) throw new Error('No such item on that list.');
      const body = Object.fromEntries(ITEM_FIELDS.map((k) => [k, item[k]]));
      if (body.remind) body.remind = { at: body.remind.at, channel: body.remind.channel };
      const r = await call('PUT', `/lists/${listId}/items/${itemId}`, { ...body, ...patch, rev: item.rev });
      if (r.status === 200) return { list: got.out.list, item: r.out };
      if (r.status !== 409) fail(r);
    }
    throw new Error('That item keeps changing; try again in a moment.');
  }

  return {
    async change(input, { history = [] } = {}) {
      const { action, list_id: listId, item_id: itemId } = input;
      const need = (...keys) => { for (const k of keys) if (!input[k]) throw new Error(`${action} needs ${k}`); };
      const record = (outcome, detail) => audit({ tool: 'family_lists', action: `${action}${listId ? ` ${listId}` : ''}${itemId ? `/${itemId}` : ''}`, outcome, ...(detail ? { detail } : {}) });
      try {
        let said;
        switch (action) {
          case 'add_item': {
            need('list_id', 'text');
            const got = await call('GET', `/lists/${listId}`);
            if (got.status !== 200) fail(got);
            const order = Math.max(0, ...got.out.items.map((i) => i.order || 0)) + 1;
            const r = await call('PUT', `/lists/${listId}/items/${uid()}`, { order, ...changes(input) });
            if (r.status !== 200) fail(r);
            said = `Added “${r.out.text}” to ${got.out.list.name}${r.out.remind ? `, with a reminder at ${r.out.remind.at}` : ''}.`;
            break;
          }
          case 'update_item':
          case 'complete_item':
          case 'reopen_item': {
            need('list_id', 'item_id');
            const patch = action === 'update_item' ? changes(input) : { done: action === 'complete_item' };
            const { list, item } = await changeItem(listId, itemId, patch);
            said = action === 'update_item' ? `Updated “${item.text}” on ${list.name}.` : `${item.done ? 'Ticked off' : 'Reopened'} “${item.text}” on ${list.name}.`;
            break;
          }
          case 'delete_item': {
            need('list_id', 'item_id');
            const r = await call('DELETE', `/lists/${listId}/items/${itemId}`);
            if (r.status !== 200) fail(r);
            said = 'Deleted that item.';
            break;
          }
          case 'create_list': {
            need('name');
            const r = await call('POST', '/lists', { name: input.name, layout: input.layout ?? 'checklist' });
            if (r.status !== 200) fail(r);
            said = `Started the list “${r.out.name}” (${r.out.id}). Only they can see it until they share it on the Lists page.`;
            break;
          }
          case 'rename_list':
          case 'set_layout': {
            need('list_id', action === 'rename_list' ? 'name' : 'layout');
            const got = await call('GET', `/lists/${listId}`);
            if (got.status !== 200) fail(got);
            const l = got.out.list;
            const r = await call('PUT', `/lists/${listId}`, { name: input.name ?? l.name, layout: input.layout ?? l.layout, columns: l.columns, share: l.share, rev: l.rev });
            if (r.status !== 200) fail(r);
            said = action === 'rename_list' ? `Renamed it “${r.out.name}”.` : `${r.out.name} is now a ${r.out.layout}.`;
            break;
          }
          case 'delete_list': {
            need('list_id');
            let path = `/lists/${listId}`;
            if (input.confirm) {
              const p = pendingIn(history, 'lists');
              if (!p || p.list_id !== listId) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
              if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
              path += `?confirm_id=${encodeURIComponent(p.confirm_id)}`;
            }
            const r = await call('DELETE', path);
            if (r.status === 202) {
              await record('asked', r.out.prompt);
              return asking('lists', { ask_them: r.out.prompt, confirm_id: r.out.confirm_id, list_id: listId });
            }
            if (r.status !== 200) fail(r);
            said = 'Deleted the list.';
            break;
          }
          default:
            throw new Error(`Unknown action ${action}`);
        }
        await record('ok');
        return said;
      } catch (e) {
        await record('error', e.message.slice(0, 200));
        throw e;
      }
    },
  };
}
