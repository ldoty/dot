// Calls a tool's Lambda handler the way API Gateway (HTTP API, payload v2) would.
//
//   const call = caller(handler, ['GET /items', 'PUT /items/{id}']);
//   const { status, body } = await call('PUT', '/items/x1', { name: 'Milk' }, token);
//   await call('GET', '/search?q=milk', undefined, token);   // -> queryStringParameters
//   -> { status, headers, body }
//
// Unknown routes get API Gateway's 404 without reaching the handler.
export function caller(handler, routeKeys) {
  const routes = routeKeys.map((key) => {
    const [method, pattern] = key.split(' ');
    const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
    return { key, method, re };
  });
  return async (method, url, body, token) => {
    const [path, query] = url.split('?');
    const route = routes.find((r) => r.method === method && r.re.test(path));
    if (!route) return { status: 404, body: { message: 'Not Found' } };
    const params = route.re.exec(path).groups;
    const res = await handler({
      routeKey: route.key,
      pathParameters: params ? { ...params } : undefined,
      queryStringParameters: query ? Object.fromEntries(new URLSearchParams(query)) : undefined,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // An empty body (202, 405) comes back as undefined. headers isn't enumerable, so tests that
    // deepEqual a whole response still compare only status and body.
    const out = { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
    return Object.defineProperty(out, 'headers', { value: res.headers ?? {} });
  };
}
