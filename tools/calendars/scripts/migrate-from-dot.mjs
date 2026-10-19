// One-off (2026-10-19): the calendars Dot had in its own settings (tools/assistant infra var.people)
// moved here, each checked with Google, with the same access as before. Safe to rerun: rows that
// exist are left alone.   AWS_PROFILE=ldoty node tools/calendars/scripts/migrate-from-dot.mjs
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { makeGoogleAuth } from '../api/google.mjs';

process.env.AWS_REGION ??= 'us-east-1';
const TABLE = 'family-calendars';
const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004', AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07';
const CALENDARS = {
  luke: 'luke.doty@gmail.com',
  kids: 'c_f537b84b64316f087a7eaccd63171d16078c755c3075041292daf050708b1fa8@group.calendar.google.com',
  amber: 'amber.n.brackett@gmail.com',
};
// As Dot had it: Luke changes his and the kids', sees Amber's; Amber changes hers, sees the others
const GRANTS = [
  ['mluke1', LUKE, 'luke', 'edit'], ['mluke2', AMBER, 'luke', 'read'],
  ['mkids1', LUKE, 'kids', 'edit'], ['mkids2', AMBER, 'kids', 'read'],
  ['mambr1', AMBER, 'amber', 'edit'], ['mambr2', LUKE, 'amber', 'read'],
];

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const token = makeGoogleAuth({ loadKey: async () => JSON.parse((await ssm.send(new GetParameterCommand({ Name: '/family/calendar/google-key', WithDecryption: true }))).Parameter.Value) });
const google = async (path, init = {}) => {
  const r = await fetch(`https://www.googleapis.com/calendar/v3${path}`, { ...init, headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' } });
  return { ok: r.ok, body: await r.json() };
};
const putNew = async (Item) => {
  try {
    await db.send(new PutCommand({ TableName: TABLE, Item, ConditionExpression: 'attribute_not_exists(pk)' }));
    return 'added';
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return 'already there';
    throw e;
  }
};

const at = new Date().toISOString();
for (const [alias, googleId] of Object.entries(CALENDARS)) {
  const cal = await google(`/calendars/${encodeURIComponent(googleId)}`);
  if (!cal.ok) throw new Error(`${alias}: Dot’s Google account can’t see it`);
  const role = (await google('/users/me/calendarList', { method: 'POST', body: JSON.stringify({ id: googleId }) })).body.accessRole ?? 'reader';
  console.log(`calendar ${alias} (${cal.body.summary}, ${role}):`, await putNew({ pk: 'CAL', sk: alias, googleId, name: cal.body.summary, role, rev: 1, addedBy: 'migration', addedAt: at }));
}
for (const [id, sub, calendar, level] of GRANTS) {
  console.log(`grant ${calendar} ${sub === LUKE ? 'Luke' : 'Amber'} ${level}:`, await putNew({ pk: 'GRANT', sk: id, who: `sub:${sub}`, calendar, level, rev: 1, changedBy: 'migration', changedAt: at }));
}
