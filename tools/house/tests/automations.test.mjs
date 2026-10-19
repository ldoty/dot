import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { KID, LUKE, audit, call, familyGroup, people, relay, seed, table, token } from './helpers/house.mjs';

const { createRelayWs } = await import('../api/relay-ws.mjs');
const grant = (sk, who, where, level) => table.put({ pk: 'GRANT', sk, who, where, level });
const kid = (over) => token({ sub: KID, ...over });
const dot = (sub = KID) => token({ sub, clientId: 'house-via-dot', via: 'dot' });
const MORNING = {
  name: 'Kitchen mornings', when: { at: '06:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }, { entity_id: 'light.kitchen_island_pendants', action: 'turn_on' }],
};
const ids = () => relay.automations.items.map((a) => a.id);
const runnable = () => relay.automations.items.map((a) => a.name);

beforeEach(seed);

test('an admin makes one: stored, described, and sent to the relay at once', async () => {
  const r = await call('POST', '/automations', MORNING);
  assert.equal(r.status, 201);
  assert.equal(r.body.says, 'Every weekday at 6:00 AM: turn on kitchen main (80%) and turn on kitchen island pendants');
  assert.deepEqual([r.body.status, r.body.owner.sub, r.body.mine, r.body.can_change, r.body.enabled], ['on', LUKE, true, true, true]);
  const row = table.get('AUTO', r.body.id);
  assert.deepEqual([row.owner, row.rev, row.when], [LUKE, 1, { at: '06:00' }]);
  assert.deepEqual(relay.automations.items, [{ id: r.body.id, name: MORNING.name, when: MORNING.when, days: MORNING.days, actions: [{ ...MORNING.actions[0] }, { ...MORNING.actions[1], data: {} }], enabled: true }]);
});

test('making one needs control of every device in it, not just ask-first or read', async () => {
  grant('g1', `sub:${KID}`, 'entity:light.kitchen_main', 'control');
  grant('g2', `sub:${KID}`, 'entity:light.kitchen_island_pendants', 'confirm');
  let r = await call('POST', '/automations', MORNING, kid());
  assert.deepEqual([r.status, r.body.error], [403, 'not allowed: kitchen island pendants']);
  grant('g2', `sub:${KID}`, 'entity:light.kitchen_island_pendants', 'read');
  assert.equal((await call('POST', '/automations', MORNING, kid())).status, 403);
  grant('g2', `sub:${KID}`, 'area:kitchen', 'control');
  r = await call('POST', '/automations', MORNING, kid());
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.owner.sub, r.body.can_change], [KID, true]);
});

test('only devices and actions the house has', async () => {
  const one = (x) => ({ ...MORNING, actions: [x] });
  assert.equal((await call('POST', '/automations', one({ entity_id: 'light.garage', action: 'turn_on' }))).status, 404);
  assert.equal((await call('POST', '/automations', one({ entity_id: 'light.kitchen_main', action: 'toggle' }))).status, 400);
  assert.equal((await call('POST', '/automations', one({ entity_id: 'switch.lutron_smart_away', action: 'turn_on', data: { brightness_pct: 5 } }))).status, 400);
  assert.equal((await call('POST', '/automations', { ...MORNING, when: { at: '6am' } })).status, 400);
  assert.equal((await call('POST', '/automations', { ...MORNING, id: 'NOT-AN-ID' })).status, 400);
  assert.equal(table.dump().filter(([k]) => k.startsWith('AUTO')).length, 0);
});

test('who sees which: owners, admins, and whoever may see all its devices', async () => {
  const luke = (await call('POST', '/automations', MORNING)).body.id;
  const bed = (await call('POST', '/automations', { ...MORNING, name: 'Bedroom', actions: [{ entity_id: 'light.kitchen_main', action: 'turn_off' }, { entity_id: 'light.master_bedroom_main', action: 'turn_off' }] })).body.id;
  assert.deepEqual((await call('GET', '/automations', undefined, kid())).body, [], 'no grants, nothing');
  grant('g1', `sub:${KID}`, 'area:kitchen', 'read');
  const seen = (await call('GET', '/automations', undefined, kid())).body;
  assert.deepEqual(seen.map((a) => [a.id, a.mine, a.can_change]), [[luke, false, false]], 'the kitchen one, not the one that also reaches the bedroom');
  assert.deepEqual((await call('GET', '/automations')).body.map((a) => a.id).sort(), [bed, luke].sort());
});

test('only its owner or an admin may change or delete it', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  const id = (await call('POST', '/automations', MORNING)).body.id;
  assert.deepEqual((await call('PUT', `/automations/${id}`, { ...MORNING, rev: 1 }, kid())).status, 403);
  assert.deepEqual((await call('DELETE', `/automations/${id}`, undefined, kid())).status, 403);
  const kids = (await call('POST', '/automations', { ...MORNING, name: 'Mine' }, kid())).body.id;
  assert.equal((await call('PUT', `/automations/${kids}`, { ...MORNING, name: 'Mine, later', when: { at: '07:00' }, rev: 1 }, kid())).status, 200);
  assert.equal((await call('DELETE', `/automations/${kids}`)).status, 200, 'an admin may');
  assert.equal(table.get('AUTO', kids), undefined);
  assert.equal((await call('PUT', '/automations/nosuchone1', { ...MORNING, rev: 1 })).status, 404);
});

test('a change is rev-checked', async () => {
  const id = (await call('POST', '/automations', MORNING)).body.id;
  assert.equal((await call('PUT', `/automations/${id}`, { ...MORNING, when: { at: '06:30' } })).status, 400, 'rev required');
  assert.equal((await call('PUT', `/automations/${id}`, { ...MORNING, when: { at: '06:30' }, rev: 1 })).status, 200);
  const stale = await call('PUT', `/automations/${id}`, { ...MORNING, when: { at: '07:00' }, rev: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current.when, { at: '06:30' });
  assert.equal((await call('POST', '/automations', { ...MORNING, id })).status, 409, 'an id that exists');
});

test('pausing needs no control and keeps the owner; resuming needs control again', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  const id = (await call('POST', '/automations', MORNING, kid())).body.id;
  table.delete('GRANT', 'g1');
  grant('g2', `sub:${KID}`, 'area:kitchen', 'read');
  const paused = await call('PUT', `/automations/${id}`, { ...MORNING, enabled: false, rev: 1 }, kid());
  assert.deepEqual([paused.status, paused.body.status], [200, 'paused']);
  assert.deepEqual(ids(), []);
  assert.equal((await call('PUT', `/automations/${id}`, { ...MORNING, enabled: true, rev: 2 }, kid())).status, 403);
  assert.equal((await call('PUT', `/automations/${id}`, { ...MORNING, when: { at: '07:00' }, enabled: false, rev: 2 }, kid())).status, 403, 'pausing changes nothing else');
  // An admin pausing someone's automation leaves it theirs
  const admin = await call('PUT', `/automations/${id}`, { ...MORNING, enabled: false, rev: 2 });
  assert.equal(admin.body.owner.sub, KID);
});

test('one stops running when its owner loses control or leaves House, and says why', async () => {
  grant('grant1', `sub:${KID}`, 'area:kitchen', 'control');
  const id = (await call('POST', '/automations', MORNING, kid())).body.id;
  assert.deepEqual(ids(), [id]);
  // A grant removed: sent to the relay at once
  assert.equal((await call('DELETE', '/grants/grant1')).status, 200);
  assert.deepEqual(ids(), []);
  const [a] = (await call('GET', '/automations')).body;
  assert.deepEqual([a.status, a.why], ['stopped', 'kid@x.test can’t control kitchen main anymore']);
  // Granted again (through a family group): it runs again
  familyGroup('gkids00001', 'Kids', [KID]);
  assert.equal((await call('PUT', '/grants/grant3', { who: 'group:gkids00001', where: 'area:kitchen', level: 'control' })).status, 200);
  assert.deepEqual(ids(), [id]);
  // Gone from family_house (Cognito): the 5-minute publish drops it
  people.members = people.members.filter((p) => p.sub !== KID);
  const { handler } = await import('./helpers/house.mjs');
  assert.deepEqual(await handler.publish(), { sent: true, count: 0 });
  assert.deepEqual(ids(), []);
  assert.equal((await call('GET', '/automations')).body[0].why, 'Someone no longer uses House', 'named by the family’s names; no longer in House’s list');
});

test('a device that left the house stops it; an admin owner’s run on admin rights', async () => {
  const id = (await call('POST', '/automations', MORNING)).body.id;
  assert.deepEqual(ids(), [id]);
  people.admins = [];
  const { handler } = await import('./helpers/house.mjs');
  await handler.publish();
  assert.deepEqual(ids(), [], 'Luke is no longer an admin, and has no grants');
  people.admins = [{ sub: LUKE }];
  table.delete('ENTITY', 'light.kitchen_main');
  await handler.publish();
  assert.deepEqual(ids(), []);
  assert.equal((await call('GET', '/automations')).body[0].why, 'light.kitchen_main isn’t in the house anymore');
});

test('publishing never fails a change, with the relay offline or gone', async () => {
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: null });
  assert.equal((await call('POST', '/automations', MORNING)).status, 201);
  assert.equal(relay.automations, null);
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: 'c1' });
  relay.mode = 'gone';
  assert.equal((await call('POST', '/automations', { ...MORNING, name: 'Two' })).status, 201);
});

test('limits: per person and for the house', async () => {
  for (let i = 0; i < 25; i++) table.put({ pk: 'AUTO', sk: `auto${String(i).padStart(6, '0')}`, ...MORNING, enabled: true, owner: LUKE, rev: 1 });
  assert.match((await call('POST', '/automations', MORNING)).body.error, /most automations one person can \(25\)/);
  for (let i = 25; i < 40; i++) table.put({ pk: 'AUTO', sk: `auto${String(i).padStart(6, '0')}`, ...MORNING, enabled: true, owner: KID, rev: 1 });
  grant('g1', `sub:${KID}`, '*', 'control');
  assert.match((await call('POST', '/automations', MORNING, kid())).body.error, /most automations it can \(40\)/);
});

// ---- Dot ----

test('from Dot, every change asks first, and goes ahead only with that confirmation', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  const ask = await call('POST', '/automations', MORNING, dot());
  assert.equal(ask.status, 202);
  assert.equal(ask.body.prompt, 'Save “Kitchen mornings”? Every weekday at 6:00 AM: turn on kitchen main (80%) and turn on kitchen island pendants.');
  const id = ask.body.automation_id;
  assert.equal(table.get('AUTO', id), undefined, 'nothing saved yet');
  const go = `/automations?confirm_id=${ask.body.confirm_id}`;
  assert.equal((await call('POST', go, { ...MORNING, id, when: { at: '05:00' } }, dot())).status, 400, 'not what was asked');
  const ask2 = await call('POST', '/automations', MORNING, dot());
  const go2 = `/automations?confirm_id=${ask2.body.confirm_id}`;
  assert.equal((await call('POST', go2, { ...MORNING, id: 'otherid123' }, dot())).status, 400, 'another id');
  const ask3 = await call('POST', '/automations', MORNING, dot());
  const body = { ...MORNING, id: ask3.body.automation_id };
  assert.equal((await call('POST', `/automations?confirm_id=${ask3.body.confirm_id}`, body, token({ sub: LUKE, clientId: 'house-via-dot', via: 'dot', groups: ['family_house', 'family_house:admin'] }))).status, 400, 'someone else');
  const ask4 = await call('POST', '/automations', MORNING, dot());
  const ok = await call('POST', `/automations?confirm_id=${ask4.body.confirm_id}`, { ...MORNING, id: ask4.body.automation_id }, dot());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, ask4.body.automation_id);
  assert.equal((await call('POST', `/automations?confirm_id=${ask4.body.confirm_id}`, { ...MORNING, id: 'again12345' }, dot())).status, 400, 'once');
});

test('from Dot, changing and deleting ask first too, and a confirmation expires', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  const id = (await call('POST', '/automations', MORNING, kid())).body.id;
  const ask = await call('PUT', `/automations/${id}`, { ...MORNING, enabled: false, rev: 1 }, dot());
  assert.deepEqual([ask.status, ask.body.prompt], [202, 'Pause “Kitchen mornings”?']);
  assert.equal(table.get('AUTO', id).enabled, true);
  assert.equal((await call('PUT', `/automations/${id}?confirm_id=${ask.body.confirm_id}`, { ...MORNING, enabled: false, rev: 1 }, dot())).status, 200);
  const del = await call('DELETE', `/automations/${id}`, undefined, dot());
  assert.deepEqual([del.status, del.body.prompt], [202, 'Delete the automation “Kitchen mornings”?']);
  table.put({ ...table.get('PENDING', del.body.confirm_id), until: Date.now() - 1 });
  assert.equal((await call('DELETE', `/automations/${id}?confirm_id=${del.body.confirm_id}`, undefined, dot())).status, 400, 'expired');
  assert.ok(table.get('AUTO', id));
  const change = await call('PUT', `/automations/${id}`, { ...MORNING, when: { at: '07:15' }, rev: 2 }, dot());
  assert.equal(change.body.prompt, 'Change “Kitchen mornings” to: Every weekday at 7:15 AM: turn on kitchen main (80%) and turn on kitchen island pendants?');
});

test('Dot is still refused everything else', async () => {
  assert.equal((await call('PUT', '/grants/abcdef', { who: `sub:${KID}`, where: '*', level: 'control' }, dot())).status, 403);
  assert.equal((await call('POST', '/automations', MORNING, dot())).status, 403, 'no control, no ask');
});

// ---- the relay's reports ----

test('a run report becomes its last run and an audit row per action, as its owner', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  const id = (await call('POST', '/automations', MORNING, kid())).body.id;
  const ws = createRelayWs({ table: 'family-house', relayKey: async () => 'k' });
  const ran = { type: 'ran', id, key: '2026-10-19@360', at: '2026-10-19T10:00:02Z', results: [{ entity_id: 'light.kitchen_main', action: 'turn_on', ok: true }, { entity_id: 'light.kitchen_island_pendants', action: 'turn_on', ok: false, error: 'refused: not exposed' }] };
  assert.equal((await ws({ requestContext: { routeKey: 'ran', connectionId: 'old' }, body: JSON.stringify(ran) })).statusCode, 403, 'only the current connection');
  assert.equal((await ws({ requestContext: { routeKey: 'ran', connectionId: 'c1' }, body: JSON.stringify({ ...ran, key: 'x' }) })).statusCode, 400);
  assert.equal((await ws({ requestContext: { routeKey: 'ran', connectionId: 'c1' }, body: JSON.stringify(ran) })).statusCode, 200);
  const [a] = (await call('GET', '/automations', undefined, kid())).body;
  assert.deepEqual([a.last_run.at, a.last_run.ok], ['2026-10-19T10:00:02.000Z', false]);
  const rows = audit().filter((r) => r.via === 'automation');
  assert.deepEqual(rows.map((r) => [r.who, r.automation, r.name, r.action, r.data, r.outcome, r.error]), [
    [KID, id, 'kitchen main', 'turn_on', { brightness_pct: 80 }, 'done', null],
    [KID, id, 'kitchen island pendants', 'turn_on', {}, 'failed', 'refused: not exposed'],
  ]);
  const log = (await call('GET', '/log')).body;
  assert.equal(log.filter((l) => l.via === 'automation').length, 2);
});

test('the relay Lambda may write only what it should', async () => {
  // The fake table doesn't enforce IAM; the policy is checked here, as written
  const { readFile } = await import('node:fs/promises');
  const tf = await readFile(new URL('../infra/relay.tf', import.meta.url), 'utf8');
  assert.match(tf, /Action\s+= "dynamodb:PutItem"[\s\S]*?\["RAN", "CMD#\*"\]/);
  assert.match(tf, /Action\s+= "dynamodb:GetItem"[\s\S]*?\["AUTO"\]/);
  assert.doesNotMatch(tf, /"AUTO", |, "AUTO"\]/, 'never in the read-write statement');
  void fakeTable;
});
