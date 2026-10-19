// Dot switching the house's lights, as the person asking. Reading the house is discovered like any
// tool (House's GET /dot manifest: house_state); changing it is this built-in, because discovered
// tools are GET only. House decides everything: the person's grants, then the relay's ceiling.
// Each call borrows a short-lived token for the asker (delegation.mjs) and is audited.
//
// Confirmation is enforced here, in code, not left to the model. When House answers 202 (the
// person's grant is `confirm`), the tool result says so and records House's confirm_id; Claude
// never gets a field to pass it back. A later call with confirm: true is sent with that id only if
// the person has written a new message since: a hidden instruction in an email, invite or tool
// answer can't approve its own command within the turn it arrived in.

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

const MARK = 'needs_confirmation';

/** The latest pending confirmation in the history, and whether the person has written since */
function pendingIn(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || typeof b.content !== 'string' || !b.content.includes(MARK)) continue;
      let p;
      try { p = JSON.parse(b.content); } catch { continue; }
      if (!p[MARK]) continue;
      // The person's own words come in a user message that isn't only tool results
      const answered = history.slice(i + 1).some((n) => n.role === 'user' && n.content.some((c) => c.type === 'text' || c.type === 'image'));
      return { ...p, answered };
    }
  }
  return null;
}

export function makeHouse({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch }) {
  return {
    async control(input, { history = [] } = {}) {
      const { entity_id: entityId, action, brightness_pct: pct, confirm } = input;
      if (pct !== undefined && (action !== 'turn_on' || !(pct >= 1 && pct <= 100))) throw new Error('brightness_pct is 1–100, and only with turn_on');
      const data = pct === undefined ? {} : { brightness_pct: pct };
      const body = { entity_id: entityId, action, data };
      if (confirm) {
        const p = pendingIn(history);
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
        return JSON.stringify({ [MARK]: true, ask_them: out.prompt, confirm_id: out.confirm_id, entity_id: entityId, action, data });
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
