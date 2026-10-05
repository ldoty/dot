// Lambda entry points (bundled by `npm run build` into api/dist/index.mjs):
//   index.api   the page's API, behind API Gateway
//   index.sync  the nightly sync (EventBridge Scheduler), also started by POST /sync
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { makeDelegation } from './delegation.mjs';
import { makeStore } from './store.mjs';
import { createApi } from './api.mjs';
import { runSync } from './sync.mjs';

/** Builds the real dependencies from the Lambda environment */
export function liveDeps(env = process.env) {
  const ssm = new SSMClient({});
  const kms = new KMSClient({});
  return {
    // Its own page's tokens, and Dot's (read-only) from the delegated client
    auth: { issuer: env.ISSUER, clientId: [env.CLIENT_ID, env.DOT_CLIENT_ID].filter(Boolean), group: env.GROUP },
    dotClientId: env.DOT_CLIENT_ID,
    store: makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: env.TABLE, pk: env.PARTITION || undefined }),
    title: env.TITLE,
    mode: env.MODE || 'personal',
    // Shared Finances: the personal tools it reads ([{ app, name, sub, username, api_url, client_id }])
    sources: env.SOURCES ? JSON.parse(env.SOURCES) : [],
    tool: env.TOOL,
    // SimpleFIN setup token or access URL (SecureString; pasted in the console)
    secret: {
      get: async () => (await ssm.send(new GetParameterCommand({ Name: env.SIMPLEFIN_PARAM, WithDecryption: true }))).Parameter.Value,
      put: (value) => ssm.send(new PutParameterCommand({ Name: env.SIMPLEFIN_PARAM, Value: value, Type: 'SecureString', Overwrite: true })),
    },
    // Read-only Budget tokens for the person, signed with this tool's own key (core: delegation_signers)
    tokenFor: makeDelegation({
      region: env.AWS_REGION,
      issuer: env.SIGNER,
      sign: async (bytes) => Buffer.from((await kms.send(new SignCommand({
        KeyId: env.SIGNER_KEY, Message: bytes, MessageType: 'RAW', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
      }))).Signature),
    }),
    budgetApp: env.BUDGET ? JSON.parse(env.BUDGET) : null,
    person: env.PERSON,
    owner: { sub: env.OWNER_SUB, username: env.OWNER_USERNAME },
    client: new AnthropicBedrock({ awsRegion: env.AWS_REGION }),
    model: env.MODEL,
    timeZone: env.TIME_ZONE,
    now: () => Date.now(),
    startSync: () => new LambdaClient({}).send(new InvokeCommand({ FunctionName: env.SYNC_FUNCTION, InvocationType: 'Event' })),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

let deps;
export const api = createApi(() => (deps ??= liveDeps()));
export const sync = async () => {
  deps ??= liveDeps();
  const { ok, message, counts, errors } = await runSync(deps);
  console.log(JSON.stringify({ sync: { ok, message, counts, errors } }));
};
