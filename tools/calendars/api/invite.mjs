// Calendar invitations to people outside the family. Google won't let the service account add attendees
// (google-calendar.mjs), so dot-y.co emails each person on an event a standard invitation instead
// (iCalendar REQUEST, RFC 5545/5546): it opens as an invite in Gmail, Outlook and Apple Calendar, with
// the family member as the organizer, so the guest's RSVP goes to them. It carries the Google event's
// UID and sequence, so an invitation sent again after a change replaces the first in the guest's calendar.
// From invites@dot-y.co ("Luke Doty via dot-y.co"), Reply-To the organizer, marked as automatic.

const fold = (line) => {
  // iCalendar lines stop at 75 octets; longer ones continue on lines starting with a space
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start ? 74 : 75), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // never split a UTF-8 character
    parts.push(bytes.subarray(start, end).toString());
    start = end;
  }
  return parts.join('\r\n ');
};
const text = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const param = (v) => `"${String(v ?? '').replace(/["\r\n]/g, '')}"`;
const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (d) => String(d).slice(0, 10).replace(/-/g, '');

/** One event's start or end as iCalendar: a date for all-day, else UTC */
function when(name, t) {
  return t.date ? `${name};VALUE=DATE:${day(t.date)}` : `${name}:${utc(t.dateTime)}`;
}

/**
 * event: getEvent's answer (ical_uid, sequence, starts, ends, title, location, full_description)
 * organizer: { name, email }; attendees: [{ name?, email }] -> the .ics text
 */
export function icsInvite({ event, organizer, attendees, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//dot-y.co//Calendars//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${event.ical_uid}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `DTSTAMP:${utc(now)}`,
    when('DTSTART', event.starts),
    when('DTEND', event.ends),
    `SUMMARY:${text(event.title)}`,
    ...(event.location ? [`LOCATION:${text(event.location)}`] : []),
    ...(event.full_description ? [`DESCRIPTION:${text(event.full_description)}`] : []),
    `ORGANIZER;CN=${param(organizer.name)}:mailto:${organizer.email}`,
    ...attendees.map((a) => `ATTENDEE;${a.name ? `CN=${param(a.name)};` : ''}ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();

/** The email: a few plain lines, and the invitation both inline (so it shows as an invite) and attached */
export function inviteMessage({ from, organizer, to, event, ics, summary, boundary = `inv${Date.now().toString(36)}` }) {
  const name = String(organizer.name).replace(/["\r\n<>]/g, '');
  const body = `${name} invited you to:\n\n${event.title}\n${summary}${event.location ? `\n${event.location}` : ''}\n\nReply with Yes, Maybe or No in your calendar, or answer this email to reach ${name}.\n`;
  return [
    `From: ${header(`${name} via dot-y.co`)} <${from}>`,
    `Reply-To: ${header(name)} <${organizer.email}>`,
    `To: ${to}`,
    `Subject: ${header(`Invitation: ${event.title} (${summary})`)}`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}a"`,
    '',
    `--${boundary}a`,
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(body),
    `--${boundary}a`,
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST', 'Content-Transfer-Encoding: base64', '', b64(ics),
    `--${boundary}a--`,
    `--${boundary}`,
    'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', 'Content-Transfer-Encoding: base64', '', b64(ics),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** "Mon, Nov 2, 9:00 AM" in the calendar's time zone (or the day, for all-day) */
export function whenText(event, timeZone) {
  if (event.starts.date) return new Date(`${event.starts.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return new Date(event.starts.dateTime).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
}
