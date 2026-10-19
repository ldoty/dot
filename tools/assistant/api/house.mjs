// Dot switching the house's lights, as the person asking. Reading the house is discovered like any
// tool (House's GET /dot manifest: house_state); changing it is this built-in, because discovered
// tools are GET only. House decides everything: the person's grants, then the relay's ceiling.
// Each call borrows a short-lived token for the asker (delegation.mjs) and is audited.
//
// Confirmation is enforced in code (confirm.mjs), not left to the model: when House answers 202
// (the person's grant is `confirm`), Dot sends House's confirm_id back only after their own reply.
//
// Automations (what the house does by itself, at a time or around sunrise/sunset) are read through
// the discovered house_automations, and made, changed, paused and deleted with house_automation.
// House asks first for every one of those from Dot (202), so each needs the person's own reply, and
// the confirmed call sends exactly what was asked about: it's taken from the asking result, not
// from the model's second call.

import { asking, pendingIn } from './confirm.mjs';

export const ACTIONS = ['turn_on', 'turn_off'];

export const definition = {
  name: 'house_control',
  description: 'House: turn a light or switch on or off, or set a light’s brightness, as the person asking (only what they may control). '
    + 'Use house_state first for the device ids. If the answer says it needs their confirmation, ask them in plain words and wait for their reply; '
    + 'only if they agree, call again with the same device and action and confirm: true.',
  input_schema: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'The device’s id from house_state, e.g. light.kitchen_main' },
      action: { type: 'string', enum: ACTIONS },
      brightness_pct: { type: 'integer', description: 'With turn_on, for a dimmable light: 1–100' },
      confirm: { type: 'boolean', description: 'Only after the person agreed to a command that needed confirmation' },
    },
    required: ['entity_id', 'action'],
    additionalProperties: false,
  },
};

export const AUTOMATION_OPS = ['create', 'update', 'pause', 'resume', 'delete'];

export const automationDefinition = {
  name: 'house_automation',
  description: 'House: make, change, pause, resume or delete an automation, something the house does by itself at a time, around sunrise/sunset, '
    + 'or when something changes, like a person leaving or coming home (e.g. every weekday at 6:00 turn on the kitchen lights; when Luke leaves home, text him). '
    + 'It can switch lights and switches, and text the person who makes it (only them). As the person asking: they need control of every device it switches, '
    + 'and to be able to see what sets it off. Use house_state for device and person ids and '
    + 'house_automations for automation ids. update changes only the fields given (actions, if given, replace them all). It always asks the person first: '
    + 'ask them in plain words and wait for their reply; only if they agree, call again with the same op (and automation_id) and confirm: true.',
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: AUTOMATION_OPS },
      automation_id: { type: 'string', description: 'For update, pause, resume, delete: its id from house_automations' },
      name: { type: 'string', description: 'Short name, e.g. “Kitchen lights on weekday mornings”' },
      time: { type: 'string', description: 'At a time: "HH:MM", 24-hour, the house’s local time. Or use sun' },
      sun: { type: 'string', enum: ['sunrise', 'sunset'], description: 'Around sunrise or sunset instead of a time' },
      when_changes: { type: 'string', description: 'Instead of a time: when this device or person (id from house_state, e.g. person.luke_doty) changes to `to`' },
      to: { type: 'string', enum: ['home', 'not_home', 'on', 'off'], description: 'With when_changes: not_home is leaving home, home is coming home' },
      notify: { type: 'string', description: 'Text this to the person making it (only them) each time it runs: plain words, no links, up to 160 characters' },
      offset_minutes: { type: 'integer', description: 'With sun: minutes before (negative) or after, -180 to 180' },
      repeat: {
        type: 'string',
        description: 'Which days, as a calendar RRULE (no "RRULE:"), the same as for lists and scheduled asks; leave out for every day. '
          + 'Weekdays: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR. Weekends: FREQ=WEEKLY;BYDAY=SA,SU. Every other Monday: FREQ=WEEKLY;INTERVAL=2;BYDAY=MO. '
          + 'First Saturday of the month: FREQ=MONTHLY;BYDAY=1SA. UNTIL=YYYYMMDD to end it (no COUNT).',
      },
      start: { type: 'string', description: 'YYYY-MM-DD: the first day it may run (default today); it also sets which weeks “every other” means' },
      actions: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: 'From house_state' },
            action: { type: 'string', enum: ACTIONS },
            brightness_pct: { type: 'integer', description: 'With turn_on, for a dimmable light: 1–100' },
            transition_s: { type: 'integer', description: 'Fade over this many seconds, for a light: 1–600' },
          },
          required: ['entity_id', 'action'],
          additionalProperties: false,
        },
      },
      confirm: { type: 'boolean', description: 'Only after the person agreed' },
    },
    required: ['op'],
    additionalProperties: false,
  },
};

/** The model's fields -> House's automation fields (only what was given) */
function automationFields(i) {
  const out = {};
  if (i.name !== undefined) out.name = i.name;
  if ([i.time, i.sun, i.when_changes].filter((x) => x !== undefined).length > 1) throw new Error('Give one of time, sun or when_changes.');
  if ((i.when_changes === undefined) !== (i.to === undefined)) throw new Error('when_changes and to go together.');
  if (i.offset_minutes !== undefined && i.sun === undefined) throw new Error('offset_minutes goes with sun.');
  if (i.time !== undefined) out.when = { at: i.time };
  if (i.sun !== undefined) out.when = { sun: i.sun, offset: i.offset_minutes ?? 0 };
  if (i.when_changes !== undefined) out.when = { changes: i.when_changes, to: i.to };
  if (i.notify !== undefined) out.notify = i.notify ? { message: i.notify } : null;
  if (i.start !== undefined && i.repeat === undefined) throw new Error('start goes with repeat.');
  if (i.repeat !== undefined) out.repeat = { rule: i.repeat, ...(i.start !== undefined ? { start: i.start } : {}) };
  if (i.actions !== undefined) {
    out.actions = i.actions.map((x) => {
      if (x.brightness_pct !== undefined && (x.action !== 'turn_on' || !(x.brightness_pct >= 1 && x.brightness_pct <= 100))) throw new Error('brightness_pct is 1–100, and only with turn_on');
      if (x.transition_s !== undefined && !(x.transition_s >= 1 && x.transition_s <= 600)) throw new Error('transition_s is 1–600');
      const data = {};
      if (x.brightness_pct !== undefined) data.brightness_pct = x.brightness_pct;
      if (x.transition_s !== undefined) data.transition = x.transition_s;
      return { entity_id: x.entity_id, action: x.action, data };
    });
  }
  return out;
}

export function makeHouse({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch }) {
  async function call(method, path, body, what) {
    const record = (outcome, detail) => audit({ tool: 'family_house', action: what, outcome, ...(detail ? { detail } : {}) });
    let token;
    try {
      token = await tokenFor({ clientId, sub: user.sub, username: user.username, channel });
    } catch (e) {
      await record(e.denied ? 'denied' : 'error', e.message);
      throw new Error(e.denied ? 'This person doesn’t have access to the house.' : 'Couldn’t reach the house right now.');
    }
    const res = await fetch(`${apiUrl}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let out = {};
    try { out = await res.json(); } catch { /* not JSON */ }
    if (method !== 'GET') await record(res.status === 202 ? 'asked' : res.ok ? 'ok' : res.status === 403 ? 'denied' : 'error', res.ok ? undefined : `house ${res.status}${out.error ? `: ${out.error}` : ''}`);
    return { res, out };
  }

  return {
    async automation(input, { history = [] } = {}) {
      const { op, automation_id: id, confirm } = input;
      let req;
      if (confirm) {
        // Exactly what the person was asked about, never a new version from this call
        const p = pendingIn(history, 'house_automation');
        if (!p || p.op !== op || (op !== 'create' && p.automation_id !== id)) throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
        if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
        req = { method: p.method, path: `${p.path}?confirm_id=${encodeURIComponent(p.confirm_id)}`, body: p.body };
      } else {
        const fields = automationFields(input);
        if (op === 'create') {
          if (!fields.name || !fields.when || !(fields.actions?.length || fields.notify)) throw new Error('create needs name, time, sun or when_changes, and actions or notify.');
          req = { method: 'POST', path: '/automations', body: fields };
        } else {
          if (!/^[a-z0-9]{8,24}$/.test(id ?? '')) throw new Error('automation_id: from house_automations');
          if (op === 'delete') req = { method: 'DELETE', path: `/automations/${id}` };
          else {
            const { res, out } = await call('GET', '/automations');
            if (!res.ok) throw new Error(`House answered ${res.status}${out.error ? `: ${out.error}` : ''}`);
            const cur = out.find((a) => a.id === id);
            if (!cur) throw new Error('No automation with that id that this person can see.');
            const base = { name: cur.name, when: cur.when, repeat: cur.repeat, actions: cur.actions.map(({ entity_id, action, data }) => ({ entity_id, action, data })), notify: cur.notify ?? null, enabled: cur.enabled, rev: cur.rev };
            const next = op === 'update' ? { ...base, ...fields } : { ...base, enabled: op === 'resume' };
            req = { method: 'PUT', path: `/automations/${id}`, body: next };
          }
        }
      }
      const { res, out } = await call(req.method, req.path, req.body, `${req.method} ${req.path.split('?')[0]}${confirm ? ' (confirmed)' : ''}`);
      if (res.status === 202) {
        const automationId = op === 'create' ? out.automation_id : id;
        // A new automation is named by the id House picked when it asked
        const body = op === 'create' ? { ...req.body, id: automationId } : req.body;
        return asking('house_automation', { ask_them: out.prompt, confirm_id: out.confirm_id, op, automation_id: automationId, method: req.method, path: req.path, body });
      }
      if (res.ok) {
        if (op === 'delete') return 'Deleted.';
        return `Saved: ${out.says}${out.status === 'paused' ? ' (paused)' : out.status === 'stopped' ? ` (but it won’t run: ${out.why})` : ''}.`;
      }
      if (res.status === 403) throw new Error(`Not allowed${out.error ? `: ${out.error}` : ''}.`);
      if (res.status === 409) throw new Error('Someone changed it just now; read it again with house_automations.');
      throw new Error(`House answered ${res.status}${out.error ? `: ${out.error}` : ''}`);
    },

    async control(input, { history = [] } = {}) {
      const { entity_id: entityId, action, brightness_pct: pct, confirm } = input;
      if (pct !== undefined && (action !== 'turn_on' || !(pct >= 1 && pct <= 100))) throw new Error('brightness_pct is 1–100, and only with turn_on');
      const data = pct === undefined ? {} : { brightness_pct: pct };
      const body = { entity_id: entityId, action, data };
      if (confirm) {
        const p = pendingIn(history, 'house');
        if (!p || p.entity_id !== entityId || p.action !== action || JSON.stringify(p.data) !== JSON.stringify(data)) {
          throw new Error('Nothing like that is waiting for confirmation. Send it without confirm first.');
        }
        if (!p.answered) throw new Error('Wait for the person’s reply before confirming.');
        body.confirm_id = p.confirm_id;
      }

      const what = `POST /commands ${action} ${entityId}${pct === undefined ? '' : ` ${pct}%`}${confirm ? ' (confirmed)' : ''}`;
      const record = (outcome, detail) => audit({ tool: 'family_house', action: what, outcome, ...(detail ? { detail } : {}) });
      let token;
      try {
        token = await tokenFor({ clientId, sub: user.sub, username: user.username, channel });
      } catch (e) {
        await record(e.denied ? 'denied' : 'error', e.message);
        throw new Error(e.denied ? 'This person doesn’t have access to the house.' : 'Couldn’t reach the house right now.');
      }
      const res = await fetch(`${apiUrl}/commands`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      let out = {};
      try { out = await res.json(); } catch { /* not JSON */ }
      if (res.status === 202) {
        await record('asked', out.prompt);
        return asking('house', { ask_them: out.prompt, confirm_id: out.confirm_id, entity_id: entityId, action, data });
      }
      if (res.ok) {
        await record('ok');
        return `Done: ${action.replace('_', ' ')} ${entityId}${pct === undefined ? '' : ` at ${pct}%`}.`;
      }
      await record(res.status === 403 ? 'denied' : 'error', `house ${res.status}${out.error ? `: ${out.error}` : ''}`);
      if (res.status === 403) throw new Error('This person isn’t allowed to control that.');
      throw new Error(`House answered ${res.status}${out.error ? `: ${out.error}` : ''}`);
    },
  };
}
