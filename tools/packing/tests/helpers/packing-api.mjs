// The real packing handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-packing', GROUP: 'lukes_packing', ISSUER, CLIENT_ID: 'packing-client' });
export const table = fakeTable();
const { handler } = await import('../../api/api.mjs');
export const ROUTES = ['GET /list', 'PUT /list'];
export const member = () => accessToken({ clientId: 'packing-client', group: 'lukes_packing', username: 'luke' });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = member()) => callApi(method, path, body, token);
