// Dot's calendar tools, through the Calendars tool (tools/calendars) as the person asking. Dot holds
// no Google key: Calendars decides which calendars this person may see and change (their grants),
// and its google-calendar.mjs talks to Google. This client keeps the shape Dot's tools always used
// (listCalendars, listEvents, createEvent, updateEvent, deleteEvent), so the tools and Dot's
// instructions didn't change. Deleting an event needs the person's own OK (confirm.mjs).
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

  return {
    listCalendars: () => call('GET', '/calendars'),
    listEvents: ({ calendar, start, end, query, max_results: max }) => call('GET', `/events?${qs({ calendar, start, end, query, max_results: max })}`),
    createEvent: (input) => call('POST', '/events', input, writer(`create ${input.calendar}`)),
    updateEvent: ({ calendar, event_id: id, ...rest }) => call('PUT', `/events/${encodeURIComponent(calendar)}/${encodeURIComponent(id)}`, rest, writer(`update ${calendar}/${id}`)),
    async deleteEvent({ calendar, event_id: id, confirm }, { history = [] } = {}) {
      let path = `/events/${encodeURIComponent(calendar)}/${encodeURIComponent(id)}`;
      if (confirm) {
        const p = pendingIn(history, 'calendar');
        if (!p || p.calendar !== calendar || p.event_id !== id) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
        if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
        path += `?confirm_id=${encodeURIComponent(p.confirm_id)}`;
      }
      const r = await call('DELETE', path, undefined, writer(`delete ${calendar}/${id}${confirm ? ' (confirmed)' : ''}`));
      if (r.asked) return asking('calendar', { ask_them: r.asked.prompt, confirm_id: r.asked.confirm_id, calendar, event_id: id });
      return r;
    },
  };
}
