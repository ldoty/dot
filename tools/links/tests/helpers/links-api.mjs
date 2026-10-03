// The real links handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

export const CLIENT_ID = 'links-client';
Object.assign(process.env, { TABLE: 'family-links', GROUP: 'family_links', ISSUER, CLIENT_ID });
export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const memberToken = () => accessToken({ clientId: CLIENT_ID, group: 'family_links' });
const callApi = caller(handler, ['GET /all', 'PUT /sections/{id}', 'DELETE /sections/{id}', 'PUT /links/{id}', 'DELETE /links/{id}']);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);
