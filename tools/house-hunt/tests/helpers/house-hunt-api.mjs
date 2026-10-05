// The real House Hunt handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const CLIENT_ID = 'house-hunt-client';
Object.assign(process.env, { TABLE: 'family-house-hunt', GROUP: 'family_house_hunt', ISSUER, CLIENT_ID });
export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const memberToken = () => accessToken({ clientId: CLIENT_ID, group: 'family_house_hunt' });
const callApi = caller(handler, ['GET /all', 'PUT /hoods/{id}', 'DELETE /hoods/{id}', 'PUT /notes', 'PUT /listings/{id}', 'DELETE /listings/{id}']);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);
