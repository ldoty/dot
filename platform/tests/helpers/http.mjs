// Calls a tool's Lambda handler the way API Gateway (HTTP API, payload v2) would.
//
//   const call = caller(handler, ['GET /items', 'PUT /items/{id}']);
//   const { status, body } = await call('PUT', '/items/x1', { name: 'Milk' }, token);
//
// Unknown routes get API Gateway's 404 without reaching the handler.
export function caller(handler, routeKeys) {
  const routes = routeKeys.map((key) => {
    const [method, pattern] = key.split(' ');
    const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);
    return { key, method, re };
  });
  return async (method, path, body, token) => {
    const route = routes.find((r) => r.method === method && r.re.test(path));
    if (!route) return { status: 404, body: { message: 'Not Found' } };
    const params = route.re.exec(path).groups;
    const res = await handler({
      routeKey: route.key,
      pathParameters: params ? { ...params } : undefined,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
}
