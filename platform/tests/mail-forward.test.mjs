import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewrite } from '../email/lambda/forward.mjs';

const RAW = [
  'Return-Path: <bounce@example.com>',
  'DKIM-Signature: v=1; a=rsa-sha256; d=example.com;',
  '\tb=abc123',
  'From: "Jane Reviewer" <jane@carrier.example>',
  'To: contact@dot-y.co',
  'Subject: Question about your SMS program',
  'Message-ID: <1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello,',
  'From: this line is in the body and must stay.',
].join('\r\n');

test('forwarded mail comes from the dot-y.co address and replies go to the sender', () => {
  const out = rewrite(RAW, { recipient: 'contact@dot-y.co', forwardTo: 'luke.doty@gmail.com' });
  const [head, body] = out.split('\r\n\r\n');
  assert.match(head, /^From: "Jane Reviewer via contact@dot-y\.co" <contact@dot-y\.co>$/m);
  assert.match(head, /^Reply-To: "Jane Reviewer" <jane@carrier\.example>$/m);
  assert.match(head, /^To: luke\.doty@gmail\.com$/m);
  assert.match(head, /^Subject: Question about your SMS program$/m);
  assert.match(head, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.doesNotMatch(head, /DKIM-Signature|Return-Path|Message-ID|b=abc123/, 'original signatures and ids are removed (folded lines too)');
  assert.equal((head.match(/^From:/gm) || []).length, 1);
  assert.match(body, /From: this line is in the body and must stay\./);
});

test('a bare address sender still works, and odd names can’t break the header', () => {
  const raw = 'From: jane@carrier.example\nSubject: hi\n\nbody';
  const out = rewrite(raw, { recipient: 'contact@dot-y.co', forwardTo: 'x@y.z' });
  assert.match(out, /^From: "jane@carrier\.example via contact@dot-y\.co" <contact@dot-y\.co>$/m);
  const evil = rewrite('From: "Eve\r\nBcc: victim@x.com" <eve@x.com>\r\n\r\nbody', { recipient: 'contact@dot-y.co', forwardTo: 'x@y.z' });
  assert.doesNotMatch(evil, /^Bcc:/m);
});
