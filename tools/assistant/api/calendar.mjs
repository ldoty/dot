// Google Calendar access for the assistant, limited to the calendars named in config
// ({ alias: calendarId }). Times without an offset are read as wall-clock time in `timeZone`.
// Events the assistant creates carry a private tag so it can tell them from hand-made ones.

const API = 'https://www.googleapis.com/calendar/v3';
const TAG = { source: 'home_host', by: 'assistant' };
// Ask for every event type by name, so none is left out by Google's default: flights and
// reservations Gmail adds are "fromGmail", not "default".
const EVENT_TYPES = ['default', 'fromGmail', 'outOfOffice', 'focusTime', 'workingLocation', 'birthday'];

/** "2026-10-05T14:00" (wall time in tz) -> "2026-10-05T14:00:00-04:00"; values with an offset pass through */
export function toRfc3339(value, timeZone) {
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(value)) return value;
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(value);
  if (!m) throw new Error(`Unrecognized date/time "${value}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)`);
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offsetMin = (at) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName').value; // "GMT-04:00"
    const o = /GMT([+-])(\d\d):(\d\d)/.exec(name);
    return o ? (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +o[3]) : 0;
  };
  const off = offsetMin(guess - offsetMin(guess) * 60_000);
  const sign = off < 0 ? '-' : '+', abs = Math.abs(off);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function makeCalendar({ accessToken, calendars, timeZone, fetch = globalThis.fetch }) {
  const idFor = (alias) => {
    if (!Object.hasOwn(calendars, alias)) throw new Error(`Unknown calendar "${alias}". Use one of: ${Object.keys(calendars).join(', ')}`);
    return encodeURIComponent(calendars[alias]);
  };
  async function call(method, path, body, query) {
    const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const json = await res.json();
    if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${json.error?.message || 'request failed'}`);
    return json;
  }
  // Google wants all-day ends exclusive; the assistant speaks in inclusive days
  const when = ({ start, end, all_day: allDay }) => (allDay
    ? { start: { date: start.slice(0, 10) }, end: { date: addDays((end || start).slice(0, 10), 1) } }
    : { start: { dateTime: toRfc3339(start, timeZone), timeZone }, end: { dateTime: toRfc3339(end || start, timeZone), timeZone } });
  const view = (e) => ({
    id: e.id,
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    all_day: Boolean(e.start?.date),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description.slice(0, 500) } : {}),
    ...(e.eventType && e.eventType !== 'default' ? { type: e.eventType } : {}),
    created_by_assistant: e.extendedProperties?.private?.by === 'assistant',
  });

  return {
    async listCalendars() {
      const out = [];
      for (const [alias, id] of Object.entries(calendars)) {
        const c = await call('GET', `/calendars/${encodeURIComponent(id)}`);
        out.push({ calendar: alias, name: c.summary, time_zone: c.timeZone });
      }
      return out;
    },

    async listEvents({ calendar, start, end, query, max_results: max = 25 }) {
      const r = await call('GET', `/calendars/${idFor(calendar)}/events`, null, [
        ['timeMin', toRfc3339(start, timeZone)], ['timeMax', toRfc3339(end, timeZone)],
        ['singleEvents', 'true'], ['orderBy', 'startTime'], ['maxResults', String(Math.min(Math.max(1, max), 50))],
        ...EVENT_TYPES.map((t) => ['eventTypes', t]),
        ...(query ? [['q', query]] : []),
      ]);
      return (r.items || []).filter((e) => e.status !== 'cancelled').map(view);
    },

    async createEvent({ calendar, title, location, description, ...time }) {
      const e = await call('POST', `/calendars/${idFor(calendar)}/events`, {
        summary: title, ...(location ? { location } : {}), ...(description ? { description } : {}),
        ...when(time), extendedProperties: { private: TAG },
      });
      return view(e);
    },

    async updateEvent({ calendar, event_id: eventId, title, location, description, start, end, all_day: allDay }) {
      const patch = {
        ...(title !== undefined ? { summary: title } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(start !== undefined ? when({ start, end, all_day: allDay }) : {}),
      };
      return view(await call('PATCH', `/calendars/${idFor(calendar)}/events/${encodeURIComponent(eventId)}`, patch));
    },

    async deleteEvent({ calendar, event_id: eventId }) {
      await call('DELETE', `/calendars/${idFor(calendar)}/events/${encodeURIComponent(eventId)}`);
      return { deleted: eventId };
    },
  };
}
