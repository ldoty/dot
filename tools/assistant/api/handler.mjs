// Web entry point: a Lambda Function URL with response streaming.
//   GET    /conversations       -> [{ id, title, channel, createdAt, updatedAt }]
//   GET    /conversations/{id}  -> { conversation, transcript }
//   DELETE /conversations/{id}
//   POST   /chat { conversationId?, text } -> a stream of JSON lines (one event per line):
//          {type:"conversation",id,title} {type:"text",delta} {type:"tool",name,status} {type:"error",message} {type:"done"}
// Every request needs a lukes_assistant access token, verified here.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BetaFallbackState, betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { verifyAccessToken } from './verify-token.mjs';
import { makeStore } from './store.mjs';
import { makeGoogleAuth } from './google.mjs';
import { makeCalendar } from './calendar.mjs';
import { makeTools } from './tools.mjs';
import { runTurn, toTranscript } from './agent.mjs';

/** Builds the real dependencies from the Lambda environment */
export function liveDeps(env = process.env) {
  const calendars = JSON.parse(env.CALENDARS);
  const ssm = new SSMClient({});
  const accessToken = makeGoogleAuth({
    loadKey: async () => JSON.parse((await ssm.send(new GetParameterCommand({ Name: env.GOOGLE_KEY_PARAM, WithDecryption: true }))).Parameter.Value),
  });
  const calendar = makeCalendar({ accessToken, calendars, timeZone: env.TIME_ZONE });
  return {
    auth: { issuer: env.ISSUER, clientId: env.CLIENT_ID, group: env.GROUP },
    store: makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: env.TABLE }),
    // Refusals retry on the fallback model (Bedrock has no server-side fallback)
    client: new AnthropicBedrockMantle({
      awsRegion: env.AWS_REGION,
      middleware: [betaRefusalFallbackMiddleware([{ model: env.FALLBACK_MODEL }])],
    }),
    tools: makeTools({ calendar, calendarNames: Object.keys(calendars) }),
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
        await runTurn({ ...deps, fallbackState: new BetaFallbackState(), userId, conversationId: body.conversationId, text, onEvent: send });
      } catch (e) {
        console.error('turn failed', e);
        send({ type: 'error', message: e.status === 404 ? 'That conversation no longer exists.' : 'Something went wrong. Try again.' });
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
