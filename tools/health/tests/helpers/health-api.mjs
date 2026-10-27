// The real Health handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const CLIENT_ID = 'health-client';
export const DOT_CLIENT_ID = 'health-dot-client';
Object.assign(process.env, { TABLE: 'family-health', GROUP: 'family_health', ISSUER, CLIENT_ID, DOT_CLIENT_ID });
export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const ROUTES = [
  'GET /all', 'PUT /settings', 'PUT /plan', 'PUT /exercises/{id}', 'DELETE /exercises/{id}', 'PUT /workouts/{id}', 'DELETE /workouts/{id}',
  'PUT /sessions/{id}', 'DELETE /sessions/{id}', 'PUT /weights/{date}', 'DELETE /weights/{date}', 'PUT /journal/{date}', 'PUT /food/{id}', 'DELETE /food/{id}', 'PUT /meds/{id}', 'DELETE /meds/{id}', 'PUT /doses/{date}/{id}', 'DELETE /doses/{date}/{id}', 'POST /starter',
  'GET /dot', 'GET /dot/summary', 'GET /dot/sessions', 'GET /dot/exercise', 'GET /dot/workouts', 'GET /dot/journal', 'GET /dot/food', 'GET /dot/meds', 'POST /dot/log', 'POST /dot/food', 'POST /dot/journal', 'POST /dot/dose', 'POST /dot/supplement', 'PUT /dot/supplement',
];
export const memberToken = (username = 'luke-sub') => accessToken({ clientId: CLIENT_ID, group: 'family_health', username });
/** The token Dot borrows for this person from Health's delegated client */
export const dotToken = (username = 'luke-sub') => accessToken({ clientId: DOT_CLIENT_ID, group: 'family_health', username, via: 'dot' });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);
