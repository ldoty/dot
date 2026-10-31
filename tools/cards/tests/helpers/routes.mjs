// The API's routes, for the tests (api.test.mjs checks they match infra/api.tf)
export const ROUTES = [
  'GET /dot', 'GET /decks', 'POST /decks', 'PUT /decks/{deck}', 'DELETE /decks/{deck}',
  'GET /decks/{deck}/cards', 'POST /decks/{deck}/cards', 'POST /decks/{deck}/import',
  'PUT /decks/{deck}/cards/{id}', 'DELETE /decks/{deck}/cards/{id}', 'POST /decks/{deck}/cards/{id}/review',
  'GET /study', 'GET /summary',
];
