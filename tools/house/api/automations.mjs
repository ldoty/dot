// House automations (the shape and wording are in automation.mjs, shared with the relay). Routes:
//   GET    /automations          -> [automation…] the ones this person may see: their own, and any whose
//                                   devices they may all see (admins: all). Each says whether it's on,
//                                   paused or stopped (and why), and how its last run went
//   POST   /automations          { name, when, days?, actions, enabled? } -> 201 the automation
//   PUT    /automations/{id}     { …the same, rev }  -> the automation   rev-checked (409 + current)
//   DELETE /automations/{id}                         -> { id }
// Who may: making or changing one needs `control` (not just ask-first) on every device in it, now:
// it will run with no one there to ask. Only its owner (whoever last saved it) or an admin may change
// or delete it; pausing needs no control, so anyone who could change it can always stop it.
// From Dot, every change first answers 202 { confirm_id, prompt }, and goes ahead only when sent again
// with ?confirm_id= (Dot's code sends that only after the person's own reply): same person, same
// change, within 2 minutes, once.
//
// What runs: the relay at home runs the set AWS last sent it (publish(), after every change here or to
// grants, and every 5 minutes from the house-publish Lambda), with any whose owner can no longer
// control all of its devices, or who left House, left out. The relay checks each action against its
// own ceiling again when it runs.
//
// Rows: AUTO / <id>      { name, when, days, actions, enabled, owner, rev, changedBy, changedAt }
//       RAN / <id>       the last run, from the relay (api/relay-ws.mjs)
//       PENDING / <id>   a change from Dot waiting for the person's OK
import { randomBytes } from 'node:crypto';
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AUTO_ID, MAX_AUTOMATIONS, canonical, describe, parseAutomation } from './automation.mjs';
import { atLeast, grantsFor, levelFor } from './grants.mjs';

export const PER_PERSON = 25;
const CONFIRM_MS = 2 * 60_000;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/**
 * deps: db, table, get(pk, sk), all(pk), members() and admins() -> [{ sub, name }] (Cognito),
 * people (platform/api/people.mjs), toRelay(connectionId, message), now()
 */
export function makeAutomations({ db, table, get, all, members, admins, people, toRelay, now }) {
  /** Everything a check needs, read once */
  async function world() {
    const [rows, entities, grants, groups, ran, inHouse, admin, names] = await Promise.all([
      all('AUTO'), all('ENTITY'), all('GRANT'), people.groups(), all('RAN'), members(), admins(), people.names(),
    ]);
    return {
      rows, grants, ran: new Map(ran.map((r) => [r.sk, r])),
      groups: groups.map((g) => ({ name: g.id, members: g.members })), // grants name a group by id
      entities: new Map(entities.map((e) => [e.sk, e])),
      members: new Set(inHouse.map((p) => p.sub)), admins: new Set(admin.map((p) => p.sub)),
      nameOf: (sub) => names.get(sub) ?? inHouse.find((p) => p.sub === sub)?.name ?? 'Someone',
    };
  }
  const level = (w, sub, isAdmin, id) => {
    const e = w.entities.get(id);
    return e ? levelFor({ admin: isAdmin, grants: grantsFor(sub, w.grants, w.groups) }, { id, area: e.area }) : 'none';
  };

  /** Why this saved automation can't run now, or null */
  function stopped(w, a) {
    if (!w.members.has(a.owner)) return `${w.nameOf(a.owner)} no longer uses House`;
    const isAdmin = w.admins.has(a.owner);
    for (const x of a.actions) {
      if (!w.entities.has(x.entity_id)) return `${x.entity_id} isn’t in the house anymore`;
      if (!atLeast(level(w, a.owner, isAdmin, x.entity_id), 'control')) return `${w.nameOf(a.owner)} can’t control ${w.entities.get(x.entity_id).name} anymore`;
    }
    return null;
  }

  const shape = (row) => parseAutomation(row);
  const nameIn = (w) => (id) => w.entities.get(id)?.name ?? id;

  function out(w, row, sub, isAdmin) {
    const a = shape(row);
    const why = a.enabled ? stopped(w, row) : null;
    const last = w.ran.get(row.sk);
    return {
      id: row.sk, ...a,
      actions: a.actions.map((x) => ({ ...x, name: w.entities.get(x.entity_id)?.name ?? x.entity_id })),
      says: describe(a, nameIn(w)),
      status: !a.enabled ? 'paused' : why ? 'stopped' : 'on', ...(why ? { why } : {}),
      owner: { sub: row.owner, name: w.nameOf(row.owner) }, mine: row.owner === sub, can_change: isAdmin || row.owner === sub,
      last_run: last ? { at: last.at, ok: last.ok, results: last.results } : null,
      rev: row.rev,
    };
  }

  /** The set the relay may run now */
  async function runnable() {
    const w = await world();
    return w.rows.filter((r) => r.enabled && !stopped(w, r)).map((r) => ({ id: r.sk, ...shape(r) }));
  }

  /** Send the relay its set; never fails a request (the 5-minute publish catches up) */
  async function publish() {
    try {
      const conn = await get('RELAY', 'CONN');
      if (!conn?.connectionId) return { sent: false };
      const items = await runnable();
      await toRelay(conn.connectionId, { type: 'automations', at: now().toISOString(), items });
      return { sent: true, count: items.length };
    } catch (e) {
      console.warn('publish: automations not sent', e.name ?? e.message);
      return { sent: false };
    }
  }

  /** Is the person allowed to put this automation in the house? null, or a response */
  function refuse(w, a, sub, isAdmin) {
    for (const x of a.actions) {
      const e = w.entities.get(x.entity_id);
      if (!e) return json(404, { error: `unknown device ${x.entity_id}` });
      if (!atLeast(level(w, sub, isAdmin, x.entity_id), 'control')) return json(403, { error: `not allowed: ${e.name}` });
      const allowed = e.actions?.[x.action];
      if (!allowed) return json(400, { error: `${e.name} can’t ${x.action.replace(/_/g, ' ')}` });
      const extra = Object.keys(x.data).filter((k) => !allowed.includes(k));
      if (extra.length) return json(400, { error: `${extra.join(', ')} isn’t possible for ${x.action}` });
    }
    return null;
  }

  async function putAt(item, rev) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: item,
        ...(rev === undefined
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  /**
   * Dot's changes wait for the person's OK. Without a confirm id: store what was asked and answer 202.
   * With one: true if it fits (same person, op, automation and content, in time, once), else a response.
   */
  async function confirmed(sub, op, id, body, confirmId, prompt) {
    const t = now().getTime();
    if (!confirmId) {
      const cid = randomBytes(12).toString('hex');
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: 'PENDING', sk: cid, who: sub, op, automation: id, body, until: t + CONFIRM_MS, expires: Math.floor(t / 1000) + 86_400 },
      }));
      return json(202, { confirm_id: cid, prompt });
    }
    const p = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
    if (p) await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'PENDING', sk: confirmId } }));
    if (!p || p.who !== sub || p.op !== op || p.automation !== id || p.body !== body || p.until < t) {
      return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
    }
    return true;
  }

  return {
    publish,
    runnable,

    async list(sub, isAdmin) {
      const w = await world();
      const visible = w.rows.filter((r) => isAdmin || r.owner === sub
        || r.actions.every((x) => atLeast(level(w, sub, isAdmin, x.entity_id), 'read')));
      return json(200, visible.map((r) => out(w, r, sub, isAdmin)).sort((a, b) => a.name.localeCompare(b.name)));
    },

    /** op: 'create' | 'replace' | 'delete'; via: 'dot' | 'page' */
    async change(op, { sub, username, isAdmin, via }, id, body, confirmId) {
      // A new automation's id may come with it (Dot's confirmation names the one it asked about)
      if (op === 'create') {
        id = body?.id ?? randomBytes(9).toString('hex');
        if (!AUTO_ID.test(id)) return json(400, { error: 'bad id' });
      }
      const w = await world();
      const row = op !== 'create' ? w.rows.find((r) => r.sk === id) : null;
      if (op !== 'create' && (!AUTO_ID.test(id ?? '') || !row)) return json(404, { error: 'no such automation' });
      if (row && !isAdmin && row.owner !== sub) return json(403, { error: 'only its owner or an admin may change it' });

      if (op === 'delete') {
        if (via === 'dot') {
          const ok = await confirmed(sub, op, id, '', confirmId, `Delete the automation “${row.name}”?`);
          if (ok !== true) return ok;
        }
        await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'AUTO', sk: id } }));
        console.log('automation removed', JSON.stringify({ id, by: username, via }));
        await publish();
        return json(200, { id });
      }

      let a;
      try {
        a = parseAutomation(body);
      } catch (e) {
        return json(400, { error: `bad ${e.message}` });
      }
      const rev = op === 'replace' ? body.rev : undefined;
      if (op === 'replace' && !Number.isInteger(rev)) return json(400, { error: 'rev required' });
      // Pausing changes nothing else, keeps the owner, and needs no control
      const pausing = !!row && !a.enabled && canonical(a) === canonical({ ...shape(row), enabled: false });
      if (!pausing) {
        const no = refuse(w, a, sub, isAdmin);
        if (no) return no;
      }
      if (op === 'create') {
        if (w.rows.length >= MAX_AUTOMATIONS) return json(400, { error: `the house has the most automations it can (${MAX_AUTOMATIONS})` });
        if (w.rows.filter((r) => r.owner === sub).length >= PER_PERSON) return json(400, { error: `you have the most automations one person can (${PER_PERSON})` });
      }
      if (via === 'dot') {
        const says = describe(a, nameIn(w));
        const prompt = op === 'create' ? `Save “${a.name}”? ${says}.`
          : pausing ? `Pause “${row.name}”?`
            : `Change “${row.name}” to: ${says}${a.enabled ? '' : ' (paused)'}?`;
        const ok = await confirmed(sub, op, id, `${rev ?? ''}|${canonical(a)}`, confirmId, prompt);
        if (ok !== true) return op === 'create' && ok.statusCode === 202 ? json(202, { ...JSON.parse(ok.body), automation_id: id }) : ok;
      }
      const item = {
        pk: 'AUTO', sk: id, ...a, owner: pausing ? row.owner : sub, rev: (rev ?? 0) + 1, changedBy: username, changedAt: now().toISOString(),
      };
      if (!(await putAt(item, rev))) {
        const cur = await get('AUTO', id);
        return json(409, { error: op === 'create' ? 'that automation already exists' : 'changed by someone else', current: cur ? out(w, cur, sub, isAdmin) : null });
      }
      console.log('automation saved', JSON.stringify({ id, by: username, via, enabled: a.enabled }));
      await publish();
      w.rows = [...w.rows.filter((r) => r.sk !== id), item];
      return json(op === 'create' ? 201 : 200, out(w, item, sub, isAdmin));
    },
  };
}
