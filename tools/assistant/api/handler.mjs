// Web entry point: a Lambda Function URL with response streaming.
//   GET    /conversations       -> [{ id, title, channel, createdAt, updatedAt }]
//   GET    /conversations/{id}  -> { conversation, transcript }
//   DELETE /conversations/{id}
//   POST   /chat { conversationId?, text } -> a stream of JSON lines (one event per line):
//          {type:"conversation",id,title} {type:"text",delta} {type:"tool",name,status} {type:"error",message} {type:"done"}
//   GET    /audit               -> [{ at, user, username, channel, tool, action, outcome, detail? }]
//          what Dot did with people's access: everyone's for family_assistant:admin, otherwise your own
// Every request needs a family_assistant access token, verified here. Dot then acts as that
// person: their name and calendars (PEOPLE), and their own access to other tools (delegation).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import Anthropic, { BetaFallbackState, betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { verifyAccessToken } from './verify-token.mjs';
import { makeStore } from './store.mjs';
import { makeDelegation } from './delegation.mjs';
import { makeBudget } from './budget.mjs';
import { makeGoogleAuth } from './google.mjs';
import { makeCalendar } from './calendar.mjs';
import { makeTools } from './tools.mjs';
import { runTurn, toTranscript } from './agent.mjs';

/** What to tell the page when a turn fails */
export function errorMessage(e) {
  if (e.status === 404 && !e.error) return 'That conversation no longer exists.';
  // Bedrock answers 403 permission_error when the account can't use the model yet
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude isn’t enabled for this AWS account yet (Bedrock model access).';
  if (e instanceof Anthropic.RateLimitError) return 'Too many requests right now. Wait a moment and try again.';
  return 'Something went wrong. Try again.';
}

/** Builds the real dependencies from the Lambda environment */
export function liveDeps(env = process.env) {
  // { "<cognito sub>": { name, calendars: { alias: googleCalendarId } } }
  const people = JSON.parse(env.PEOPLE || '{}');
  const budgetApp = env.BUDGET ? JSON.parse(env.BUDGET) : null;
  const ssm = new SSMClient({});
  const kms = new KMSClient({});
  const accessToken = makeGoogleAuth({
    loadKey: async () => JSON.parse((await ssm.send(new GetParameterCommand({ Name: env.GOOGLE_KEY_PARAM, WithDecryption: true }))).Parameter.Value),
  });
  const tokenFor = makeDelegation({
    region: env.AWS_REGION,
    sign: async (bytes) => Buffer.from((await kms.send(new SignCommand({
      KeyId: env.DELEGATION_KEY, Message: bytes, MessageType: 'RAW', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    }))).Signature),
  });
  const store = makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: env.TABLE });
  return {
    auth: { issuer: env.ISSUER, clientId: env.CLIENT_ID, group: env.GROUP },
    store,
    // Bedrock Runtime (InvokeModel). Opus 4.7+ needs per-account approval this account doesn't
    // have yet; this client also serves those models, so upgrading is just the model setting.
    // With FALLBACK_MODEL set, refusals retry on it (Bedrock has no server-side fallback). Off for
    // Opus 4.6: the middleware's beta flag is rejected by Bedrock Runtime's older models.
    client: new AnthropicBedrock({
      awsRegion: env.AWS_REGION,
      middleware: env.FALLBACK_MODEL ? [betaRefusalFallbackMiddleware([{ model: env.FALLBACK_MODEL }])] : [],
    }),
    /** Dot for one person: their name, their calendars, and their own access to the budget */
    forUser(claims, channel = 'web') {
      const userId = claims.sub || claims.username;
      const me = people[userId] || {};
      const calendars = me.calendars || {};
      const audit = (entry) => store.addAudit({ user: userId, username: claims.username, channel, ...entry });
      return {
        person: { name: me.name },
        tools: makeTools({
          calendar: makeCalendar({ accessToken, calendars, timeZone: env.TIME_ZONE }),
          calendarNames: Object.keys(calendars),
          budget: budgetApp && makeBudget({
            tokenFor, apiUrl: budgetApp.api_url, clientId: budgetApp.client_id,
            user: { sub: claims.sub, username: claims.username }, channel, audit,
          }),
        }),
      };
    },
    model: env.MODEL,
    timeZone: env.TIME_ZONE,
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

/** The request handler; `open(status, contentType)` returns a writable { write, end } */
export function createHandler(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;
  return async function handle(event, open) {
    deps ??= depsOrFactory();
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
    const json = (status, body) => { const out = open(status, 'application/json'); out.write(JSON.stringify(body)); out.end(); };

    let claims;
    try {
      claims = await verifyAccessToken(event.headers, deps.auth);
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const userId = claims.sub || claims.username;
    const convMatch = /^\/conversations\/([A-Za-z0-9_-]{1,40})$/.exec(path);

    if (method === 'GET' && path === '/conversations') return json(200, await deps.store.listConversations(userId));
    if (method === 'GET' && path === '/audit') {
      const admin = (claims['cognito:groups'] ?? []).includes(`${deps.auth.group}:admin`);
      return json(200, await deps.store.listAudit(admin ? {} : { user: userId }));
    }
    if (convMatch && method === 'GET') {
      const conversation = await deps.store.getConversation(userId, convMatch[1]);
      if (!conversation) return json(404, { error: 'not found' });
      return json(200, { conversation, transcript: toTranscript(await deps.store.loadMessages(userId, convMatch[1])) });
    }
    if (convMatch && method === 'DELETE') {
      await deps.store.deleteConversation(userId, convMatch[1]);
      return json(200, { deleted: convMatch[1] });
    }
    if (method === 'POST' && path === '/chat') {
      let body;
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
      } catch {
        return json(400, { error: 'bad json' });
      }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 8000) return json(400, { error: 'text is required (up to 8,000 characters)' });
      if (body.conversationId !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(body.conversationId)) return json(400, { error: 'bad conversationId' });

      const out = open(200, 'application/x-ndjson');
      const send = (e) => out.write(JSON.stringify(e) + '\n');
      try {
        const forUser = deps.forUser ? deps.forUser(claims) : {};
        await runTurn({ ...deps, ...forUser, fallbackState: new BetaFallbackState(), userId, conversationId: body.conversationId, text, onEvent: send });
      } catch (e) {
        console.error('turn failed', e);
        send({ type: 'error', message: errorMessage(e) });
      }
      send({ type: 'done' });
      return out.end();
    }
    return json(404, { error: 'no route' });
  };
}

// Lambda wiring: the Node.js runtime provides `awslambda.streamifyResponse` for response streaming
// (some bundled AWS libraries define an `awslambda` object without it, so check the function itself)
const handle = createHandler(() => liveDeps());
const streaming = typeof globalThis.awslambda?.streamifyResponse === 'function';
export const handler = streaming && globalThis.awslambda.streamifyResponse(async (event, responseStream) => {
  await handle(event, (statusCode, contentType) => globalThis.awslambda.HttpResponseStream.from(responseStream, {
    statusCode, headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  }));
});
