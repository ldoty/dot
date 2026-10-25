// The real gym handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const CLIENT_ID = 'gym-client';
export const DOT_CLIENT_ID = 'gym-dot-client';
Object.assign(process.env, { TABLE: 'family-gym', GROUP: 'family_gym', ISSUER, CLIENT_ID, DOT_CLIENT_ID });
export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const ROUTES = [
  'GET /all', 'PUT /settings', 'PUT /plan', 'PUT /exercises/{id}', 'DELETE /exercises/{id}', 'PUT /workouts/{id}', 'DELETE /workouts/{id}',
  'PUT /sessions/{id}', 'DELETE /sessions/{id}', 'PUT /weights/{date}', 'DELETE /weights/{date}', 'POST /starter',
  'GET /dot', 'GET /dot/summary', 'GET /dot/sessions', 'GET /dot/exercise', 'GET /dot/workouts', 'POST /dot/log',
];
export const memberToken = (username = 'luke-sub') => accessToken({ clientId: CLIENT_ID, group: 'family_gym', username });
/** The token Dot borrows for this person from Gym's delegated client */
export const dotToken = (username = 'luke-sub') => accessToken({ clientId: DOT_CLIENT_ID, group: 'family_gym', username, via: 'dot' });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);
