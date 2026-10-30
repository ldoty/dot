// Read-only checks against the deployed Archive: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://archive.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/dot'], ['GET', '/drawers'], ['GET', '/files'], ['POST', '/uploads'], ['PATCH', '/files/f0000000000000001']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambdas load and do their own checks', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  const api = await lambda.send(new InvokeCommand({ FunctionName: 'family-archive-api', Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /drawers', headers: {} })) }));
  assert.equal(api.FunctionError, undefined, Buffer.from(api.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(api.Payload).toString()).statusCode, 401);
  // Intake ignores a key that isn't a file
  const intake = await lambda.send(new InvokeCommand({ FunctionName: 'family-archive-intake', Payload: Buffer.from(JSON.stringify({ Records: [{ s3: { object: { key: 'nothing' } } }] })) }));
  assert.equal(intake.FunctionError, undefined, Buffer.from(intake.Payload).toString());
});

test('the bucket is private, versioned and encrypted with the archive’s key', async () => {
  const { S3Client, GetBucketVersioningCommand, GetBucketEncryptionCommand, GetPublicAccessBlockCommand, ListBucketsCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const Bucket = (await s3.send(new ListBucketsCommand({}))).Buckets.find((b) => b.Name.startsWith('family-archive-files-')).Name;
  assert.equal((await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status, 'Enabled');
  const rule = (await s3.send(new GetBucketEncryptionCommand({ Bucket }))).ServerSideEncryptionConfiguration.Rules[0];
  assert.equal(rule.ApplyServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
  assert.equal(rule.BucketKeyEnabled, true);
  const block = (await s3.send(new GetPublicAccessBlockCommand({ Bucket }))).PublicAccessBlockConfiguration;
  assert.ok(block.BlockPublicAcls && block.BlockPublicPolicy && block.IgnorePublicAcls && block.RestrictPublicBuckets);
});
