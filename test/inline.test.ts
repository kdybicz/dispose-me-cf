import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { EmailParser } from '../cloudflare/EmailParser';
import { InboxController } from '../service/api/InboxController';
import { renderEmailBody } from '../service/tools/emailBody';
import log from '../service/tools/log';
import { inlineMessage, largePng, smallPng } from './fixtures/inline';

test('preserves inline parts, IDs and multi-megabyte bytes separately from downloads', async () => {
  // given / when
  const email = await new EmailParser().parseEmail(inlineMessage);
  // then
  assert.equal(email.inlineParts.length, 6);
  assert.equal(email.inlineParts[0].contentId, 'large@fixture');
  assert.equal(email.inlineParts[1].contentId, 'second');
  assert.equal(email.inlineParts[4].contentId, undefined);
  assert.ok(largePng.length > 3 * 1024 * 1024);
  assert.deepEqual(email.inlineParts[0].content, largePng);
  assert.equal(email.attachments.length, 4);
  assert.equal(email.attachments[0].filename, 'fixture.bin');
  assert.deepEqual(email.attachments[0].content, Buffer.from([0, 1, 255]));
  const attachedImage = email.inlineParts.find((part) => part.contentId === 'attached');
  assert.equal(attachedImage?.part, 6);
  assert.equal(attachedImage?.filename, 'attached.png');
  assert.deepEqual(attachedImage?.content, smallPng);
  assert.deepEqual(email.attachments[1].content, smallPng);
  assert.equal(email.attachments[1].filename, 'attached.png');
  assert.ok(!email.inlineParts.some((part) => part.filename === 'active.svg'));
  assert.ok(!email.inlineParts.some((part) => part.filename === 'no-cid.png'));
});

test('resolves encoded and repeated CIDs to the first supported part and sanitizes active HTML', async () => {
  // given
  const email = await new EmailParser().parseEmail(inlineMessage);
  // when
  const body = renderEmailBody(email, (part) => `/image/${part}?x-api-key=synthetic`);
  // then
  assert.equal(body.match(/src="\/image\/0\?/g)?.length, 2);
  assert.equal(body.match(/src="\/image\/1\?/g)?.length, 2);
  assert.ok(!body.includes('/image/2'));
  assert.ok(!body.includes('/image/3'));
  assert.ok(body.includes('src="/image/6?x-api-key=synthetic"'));
  assert.ok(!body.includes('/image/7'));
  assert.ok(!body.includes('cid:'));
  assert.ok(!body.includes('remote.invalid'));
  assert.ok(!body.includes('script'));
  assert.ok(!body.includes('onload'));
  assert.ok(!body.includes('<form'));
  assert.ok(!body.includes('<iframe'));
  assert.ok(!body.includes('<meta'));
  assert.ok(!body.includes('<svg'));
  assert.ok(body.length < 1000);
});

test('resource errors do not log query credentials', (context) => {
  // given
  const debug = context.mock.method(log, 'debug', () => {});
  const controller = new InboxController({
    emailDatabase: {} as never,
    emailParser: new EmailParser(),
    fileSystem: {} as never,
  });
  const req = {
    params: { username: 'synthetic', id: 'abc', part: '99' },
    query: { type: 'json', 'x-api-key': 'secret-query-credential' },
  } as unknown as Request;
  const res = { status: () => res, json: () => res } as unknown as Response;
  // when
  controller.render404Response(req, res);
  // then
  assert.equal(debug.mock.calls.length, 1);
  assert.ok(!JSON.stringify(debug.mock.calls).includes('secret-query-credential'));
});

test('opens allowed links without an opener or referrer and rejects executable link schemes', async () => {
  // given
  const email = await new EmailParser().parseEmail(
    'Content-Type: text/html; charset=utf-8\r\n\r\n' +
      '<a href="https://example.net" target="_top" rel="opener" ping="https://tracker.invalid">HTTPS</a>' +
      '<a href="http://example.net" target="named-window">HTTP</a>' +
      '<a href="mailto:sender@example.net">Mail</a>' +
      '<a href="javascript:alert(1)">Script</a>' +
      '<a href="java&#x73;cript:alert(1)">Encoded script</a>' +
      '<a href="data:text/html,active">Data</a>' +
      '<a href="vbscript:active">Other executable scheme</a>',
  );
  // when
  const body = renderEmailBody(email, () => '/unused');
  // then
  assert.equal(body.match(/target="_blank"/g)?.length, 7);
  assert.equal(body.match(/rel="noopener noreferrer"/g)?.length, 7);
  assert.equal(body.match(/href=/g)?.length, 3);
  assert.ok(body.includes('href="https://example.net"'));
  assert.ok(body.includes('href="http://example.net"'));
  assert.ok(body.includes('href="mailto:sender@example.net"'));
  assert.ok(!body.includes('ping='));
  assert.ok(!body.includes('target="_top"'));
  assert.ok(!body.includes('named-window'));
  assert.ok(!body.includes('rel="opener"'));
  assert.ok(!body.includes('javascript:'));
  assert.ok(!body.includes('data:'));
  assert.ok(!body.includes('vbscript:'));
});
