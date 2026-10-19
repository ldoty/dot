// Dot switching the house's lights, as the person asking. Reading the house is discovered like any
// tool (House's GET /dot manifest: house_state); changing it is this built-in, because discovered
// tools are GET only. House decides everything: the person's grants, then the relay's ceiling.
// Each call borrows a short-lived token for the asker (delegation.mjs) and is audited.
//
// Confirmation is enforced in code (confirm.mjs), not left to the model: when House answers 202
// (the person's grant is `confirm`), Dot sends House's confirm_id back only after their own reply.

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

export function makeHouse({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch }) {
  return {
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
