// An in-memory stand-in for the family-budget table. It mocks the DynamoDB document client
// for every instance (including the one api.mjs creates at import) and enforces the DynamoDB
// rules our code depends on, so tests fail where the real table would.
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const err = (name, message) => Object.assign(new Error(message), { name });
const clone = (o) => (o === undefined ? undefined : structuredClone(o));

export function fakeTable() {
  const rows = new Map(); // `${pk}|${sk}` -> item
  const key = ({ pk, sk }) => {
    if (!pk || !sk) throw err('ValidationException', 'The AttributeValue for a key attribute cannot contain an empty string value.');
    return `${pk}|${sk}`;
  };
  const condition = (expr, values, existing) => {
    if (!expr) return true;
    if (expr === 'attribute_not_exists(pk)') return !existing;
    const m = /^rev = (:\w+)$/.exec(expr);
    if (m) return !!existing && existing.rev === values[m[1]];
    throw new Error(`fake table: unsupported condition ${expr}`);
  };

  const mock = mockClient(DynamoDBDocumentClient);
  mock.on(GetCommand).callsFake(({ Key }) => ({ Item: clone(rows.get(key(Key))) }));
  mock.on(PutCommand).callsFake(({ Item, ConditionExpression, ExpressionAttributeValues }) => {
    const k = key(Item);
    if (!condition(ConditionExpression, ExpressionAttributeValues ?? {}, rows.get(k))) {
      throw err('ConditionalCheckFailedException', 'The conditional request failed');
    }
    rows.set(k, clone(Item));
    return {};
  });
  mock.on(DeleteCommand).callsFake(({ Key }) => { rows.delete(key(Key)); return {}; });
  // Supports "SET a = :x, b = :y" (creates the item if missing, like DynamoDB)
  mock.on(UpdateCommand).callsFake(({ Key, UpdateExpression: expr, ExpressionAttributeValues: v }) => {
    const m = /^SET (.+)$/.exec(expr);
    if (!m) throw new Error(`fake table: unsupported update ${expr}`);
    const k = key(Key), item = clone(rows.get(k)) ?? { ...Key };
    for (const part of m[1].split(',')) {
      const [attr, val] = part.split('=').map((x) => x.trim());
      if (!(val in v)) throw err('ValidationException', `missing value ${val}`);
      item[attr] = clone(v[val]);
    }
    rows.set(k, item);
    return {};
  });
  mock.on(QueryCommand).callsFake(({ KeyConditionExpression: expr, ExpressionAttributeValues: v }) => {
    let prefix = null;
    if (expr === 'pk = :pk AND begins_with(sk, :p)') {
      prefix = v[':p'];
      if (!prefix) throw err('ValidationException', 'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: sk');
    } else if (expr !== 'pk = :pk') {
      throw new Error(`fake table: unsupported key condition ${expr}`);
    }
    const Items = [...rows.values()]
      .filter((i) => i.pk === v[':pk'] && (prefix === null || i.sk.startsWith(prefix)))
      .sort((a, b) => (a.sk < b.sk ? -1 : 1))
      .map(clone);
    return { Items };
  });

  return {
    put: (item) => rows.set(key(item), clone(item)),
    get: (pk, sk) => clone(rows.get(`${pk}|${sk}`)),
    keys: () => [...rows.keys()].map((k) => k.split('|')[1]).sort(),
    clear: () => rows.clear(),
  };
}
