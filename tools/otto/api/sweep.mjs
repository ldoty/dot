// Otto's sweep. EventBridge runs it every minute (infra/sweep.tf; one at a time), in AWS so a schedule
// is queued on time even while the home server is down: Otto takes it when it's back.
//   1. Each schedule whose nextAt has passed is claimed (rewritten with its next time, rev-checked, so a
//      second sweep can't queue it twice), then its saved prompt is queued as a command from `schedule`.
//      One more than MISSED_MS late (the sweep was down) isn't queued: it's recorded as missed, and moves on.
//   2. A command running longer than STUCK_MS (the agent died mid-run) is marked failed, so it doesn't
//      sit as running forever. It isn't run again: whatever it already did to the inbox stays done.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KEEP_COMMANDS_S, commandId, makeStore } from './store.mjs';
import { nextRun } from './schedules.mjs';

export const MISSED_MS = 2 * 3600_000;
export const STUCK_MS = 45 * 60_000;

/** deps: db, table, now() */
export function createSweep(deps) {
  const { all, putAt } = makeStore({ db: deps.db, table: deps.table });

  return async () => {
    const t = deps.now();
    const iso = t.toISOString();
    const queued = [], missed = [], stuck = [];
    for (const s of await all('SCHED')) {
      if (!s.enabled || !s.nextAt || s.nextAt > iso) continue;
      const late = t.getTime() - Date.parse(s.nextAt) > MISSED_MS;
      const id = late ? null : commandId(t);
      const claimed = {
        ...s, nextAt: nextRun(s, iso), rev: s.rev + 1,
        ...(late ? { lastRun: { at: s.nextAt, outcome: 'missed' } } : {}),
      };
      if (!(await putAt(claimed, s.rev))) continue; // changed or claimed meanwhile
      if (late) { missed.push(s.sk); continue; }
      await putAt({
        pk: 'CMD', sk: id, prompt: s.prompt, source: 'schedule', schedule: s.sk, status: 'queued', by: s.owner,
        createdAt: iso, rev: 1, expires: Math.floor(t.getTime() / 1000) + KEEP_COMMANDS_S,
      });
      queued.push(id);
    }
    for (const c of await all('CMD')) {
      if (c.status !== 'running' || t.getTime() - Date.parse(c.startedAt) < STUCK_MS) continue;
      if (await putAt({ ...c, status: 'failed', result: 'Otto didn’t finish this (it stopped answering mid-run).', finishedAt: iso, rev: c.rev + 1 }, c.rev)) {
        stuck.push(c.sk);
        if (c.schedule) {
          const s = (await all('SCHED')).find((x) => x.sk === c.schedule);
          if (s) await putAt({ ...s, lastRun: { at: iso, outcome: 'failed', command: c.sk }, rev: s.rev + 1 }, s.rev);
        }
      }
    }
    if (queued.length || missed.length || stuck.length) console.log(JSON.stringify({ queued, missed, stuck }));
    return { queued, missed, stuck };
  };
}

let live;
export const handler = async () => (live ??= createSweep({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: process.env.TABLE, now: () => new Date(),
}))();
