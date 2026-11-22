// Loads the real SDC/SCE Budget handler against the fake table, with the env it gets in AWS,
// and turns HTTP-style calls into the API Gateway events it receives.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const PK = 'BUSINESS#sdc-sce';
export const GROUP = 'sdc_sce_budget';
export const CLIENT_ID = 'sdc-budget-client';
export const DELEGATED_CLIENT_ID = 'sdc-budget-delegated';
Object.assign(process.env, { TABLE: 'family-sdc-sce-budget', BUSINESS: 'sdc-sce', GROUP, ISSUER, CLIENT_ID, DELEGATED_CLIENT_ID });

export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const memberToken = () => accessToken({ clientId: CLIENT_ID, group: GROUP });
export const ROUTES = [
  'GET /all', 'PUT /docs/{doc}/state', 'PUT /docs/{doc}/versions/{id}',
  'DELETE /docs/{doc}/versions/{id}', 'PUT /docs/{doc}/tags/{name}', 'DELETE /docs/{doc}/tags/{name}',
];
const callApi = caller(handler, ROUTES);

/** Calls the handler like API Gateway would, as a member unless a token is given. */
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);

// Invented numbers: $10,000/mo income, $6,000 of expenses, $1,000 set aside
export const businessDoc = (rent = 2000) => ({
  income: [{ id: 'i1', name: 'Sales', amount: 10000, freq: 'mo' }],
  categories: [
    { id: 'c1', name: 'Operations', kind: 'spend', items: [{ id: 'r1', name: 'Rent', amount: rent, freq: 'mo' }, { id: 'w1', name: 'Wages', amount: 4000, freq: 'mo' }] },
    { id: 'c2', name: 'Reserve', kind: 'save', items: [{ id: 's1', name: 'Taxes', amount: 12000, freq: 'yr' }] },
  ],
});

/** Resets the table: the working copy at rev 1 and one version "Plan" (same numbers) tagged default. */
export function seed({ working = businessDoc(), version = businessDoc() } = {}) {
  table.clear();
  table.put({ pk: PK, sk: 'DOC#Business#STATE', state: JSON.stringify(working), rev: 1 });
  table.put({ pk: PK, sk: 'DOC#Business#VERSION#v1', name: 'Plan', savedAt: 1, state: JSON.stringify(version) });
  table.put({ pk: PK, sk: 'TAG#Business#default', versionId: 'v1' });
}
