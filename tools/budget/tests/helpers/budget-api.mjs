// Loads the real budget Lambda handler against the fake table, with the env it gets in AWS,
// and turns HTTP-style calls into the API Gateway events it receives.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const PK = 'HOUSEHOLD#luke-amber';
export const CLIENT_ID = 'budget-client';
export const DOT_CLIENT_ID = 'budget-via-dot';
Object.assign(process.env, { TABLE: 'family-budget', HOUSEHOLD: 'luke-amber', GROUP: 'family_budget', ISSUER, CLIENT_ID, DELEGATED_CLIENT_ID: DOT_CLIENT_ID });

export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const memberToken = () => accessToken({ clientId: CLIENT_ID, group: 'family_budget' });

const callApi = caller(handler, [
  'GET /all', 'GET /defaults', 'PUT /docs/{doc}/state', 'PUT /docs/{doc}/versions/{id}',
  'DELETE /docs/{doc}/versions/{id}', 'PUT /docs/{doc}/tags/{name}', 'DELETE /docs/{doc}/tags/{name}', 'PUT /plan',
]);

/** Calls the handler like API Gateway would, as a family_budget member unless a token is given. */
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);

// A small household: $1,000/mo shared bills, split 50/50, so each person's share is $500
export const sharedDoc = (amount = 1000, split = 50) => ({
  categories: [{ id: 'c1', name: 'Home', kind: 'spend', items: [{ id: 'a9', name: 'Bills', amount, freq: 'mo', who: 'Shared' }] }],
  mortgage: { price: 0, down: 0, rate: 6, years: 30 }, split,
});
export const personDoc = (p, follows = 'default') => ({
  income: [{ id: `${p}i`, name: 'Pay', amount: 3000, freq: 'mo' }],
  categories: [{ id: `${p}c`, name: 'Needs', kind: 'spend', items: [
    { id: `${p}s`, name: 'To shared', calc: 'share', person: p, freq: 'mo' }, // moves to the fixed Shared contributions section
    { id: `${p}p`, name: 'Phone', amount: 0, freq: 'mo' },
  ] }],
  follows,
});

/** Resets the table to: three docs at rev 1, one shared version "Starting point" tagged default.
 *  The shared working copy ($2,000) differs from it and isn't saved, so Shared opens with the unsaved banner. */
export function seed({ working = sharedDoc(2000) } = {}) {
  table.clear();
  const doc = (d, state) => table.put({ pk: PK, sk: `DOC#${d}#STATE`, state: JSON.stringify(state), rev: 1 });
  doc('shared', working); doc('Luke', personDoc('Luke')); doc('Amber', personDoc('Amber'));
  table.put({ pk: PK, sk: 'DOC#shared#VERSION#v1', name: 'Starting point', savedAt: 1, state: JSON.stringify(sharedDoc(1000)) });
  table.put({ pk: PK, sk: 'TAG#shared#default', versionId: 'v1' });
  table.put({ pk: PK, sk: 'DEFAULTS', state: JSON.stringify({ ...sharedDoc(1000), people: { Luke: personDoc('Luke'), Amber: personDoc('Amber') } }) });
}
