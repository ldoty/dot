// Dot's calendar tools, through the Calendars tool (tools/calendars) as the person asking. Dot holds
// no Google key: Calendars decides which calendars this person may see and change (their grants),
// and its google-calendar.mjs talks to Google. This client keeps the shape Dot's tools always used
// (listCalendars, listEvents, createEvent, updateEvent, deleteEvent), so the tools and Dot's
// instructions didn't change. Deleting an event, and emailing invitations to the people on one, need the
// person's own OK (confirm.mjs).
import { asking, pendingIn } from './confirm.mjs';

// Google's event colors by the names its app shows (the same list as tools/calendars/api/google-calendar.mjs)
export const COLORS = ['lavender', 'sage', 'grape', 'flamingo', 'banana', 'tangerine', 'peacock', 'graphite', 'blueberry', 'basil', 'tomato'];

export function makeCalendars({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch }) {
  async function call(method, path, body, record) {
    let token;
    try {
      token = await tokenFor({ clientId, sub: user.sub, username: user.username, channel });
    } catch (e) {
      throw new Error(e.denied ? 'This person doesn’t have access to Calendars.' : 'Couldn’t reach Calendars right now.');
    }
    const res = await fetch(`${apiUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let out = {};
    try { out = await res.json(); } catch { /* not JSON */ }
    if (record) await record(res.ok || res.status === 202 ? (res.status === 202 ? 'asked' : 'ok') : res.status === 403 ? 'denied' : 'error', res.ok ? undefined : out.error);
    if (res.status === 202) return { asked: out };
    if (!res.ok) throw new Error(out.error || `Calendars answered ${res.status}`);
    return out;
  }
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  const writer = (what) => (outcome, detail) => audit({ tool: 'family_calendars', action: what, outcome, ...(detail ? { detail } : {}) });

  /** Send a write that Calendars may answer with 202 (asks first); with confirm, exactly what was asked about */
  async function confirmable({ kind, method, path, body, calendar, id, confirm, history, what }) {
    if (confirm) {
      const p = pendingIn(history, kind, (x) => x.calendar === calendar && x.event_id === id);
      if (!p) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
      if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
      path += `?confirm_id=${encodeURIComponent(p.confirm_id)}`;
      body = p.body ?? body;
    }
    const r = await call(method, path, body, writer(`${what}${confirm ? ' (confirmed)' : ''}`));
    if (r.asked) return asking(kind, { ask_them: r.asked.prompt, confirm_id: r.asked.confirm_id, calendar, event_id: id, ...(body ? { body } : {}) });
    return r;
  }

  return {
    listCalendars: () => call('GET', '/calendars'),
    listEvents: ({ calendar, start, end, query, max_results: max }) => call('GET', `/events?${qs({ calendar, start, end, query, max_results: max })}`),
    createEvent: (input) => call('POST', '/events', input, writer(`create ${input.calendar}`)),
    updateEvent: ({ calendar, event_id: id, ...rest }) => call('PUT', `/events/${encodeURIComponent(calendar)}/${encodeURIComponent(id)}`, rest, writer(`update ${calendar}/${id}`)),
    deleteEvent: ({ calendar, event_id: id, confirm }, { history = [] } = {}) => confirmable({
      kind: 'calendar', method: 'DELETE', path: `/events/${encodeURIComponent(calendar)}/${encodeURIComponent(id)}`, calendar, id, confirm, history, what: `delete ${calendar}/${id}`,
    }),
    // Emails people outside the family, so always asked first; the confirmation sends exactly the people asked about
    inviteEvent: ({ calendar, event_id: id, emails, confirm }, { history = [] } = {}) => confirmable({
      kind: 'calendar_invite', method: 'POST', path: `/events/${encodeURIComponent(calendar)}/${encodeURIComponent(id)}/invite`,
      body: emails ? { emails } : {}, calendar, id, confirm, history, what: `invite ${calendar}/${id}`,
    }),
  };
}
