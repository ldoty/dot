// The real trip planner handler on an in-memory table, called the way API Gateway calls it.
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-trip-planner', GROUP: 'lukes_trip_planner', ISSUER, CLIENT_ID: 'trips-client' });
export const table = fakeTable({ pageSize: 2 });   // listing trips must follow pages
const { handler } = await import('../../api/api.mjs');
export const ROUTES = ['GET /trips', 'GET /trips/{id}', 'PUT /trips/{id}', 'DELETE /trips/{id}'];
export const member = () => accessToken({ clientId: 'trips-client', group: 'lukes_trip_planner', username: 'luke' });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = member()) => callApi(method, path, body, token);

// Invented fixtures, not real trips (those live in the table, and the first came from private/).
export const trip = (over = {}) => ({
  name: 'Ridge loop', type: 'backpacking', where: 'Site 3', start: '2026-11-14', end: '2026-11-15',
  notes: 'Permit in the glovebox', itinerary: 'Sat: hike in\nSun: hike out',
  categories: [{ id: 'cat1', name: 'Shelter' }, { id: 'cat2', name: 'Kitchen' }],
  items: [
    { id: 'i1', text: 'Tent', categoryId: 'cat1', status: '' },
    { id: 'i2', text: 'Fuel', categoryId: 'cat2', status: 'b' },
    { id: 'i3', text: 'Stove', categoryId: 'cat2', status: 'x' },
  ],
  ...over,
});
