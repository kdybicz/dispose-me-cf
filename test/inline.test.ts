import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { EmailParser } from '../cloudflare/EmailParser';
import { InboxController } from '../service/api/InboxController';
import { renderEmailBody } from '../service/tools/emailBody';
import log from '../service/tools/log';
import { inlineMessage, largePng } from './fixtures/inline';

test('preserves inline parts, IDs and multi-megabyte bytes separately from downloads', async () => {
  // given / when
  const email = await new EmailParser().parseEmail(inlineMessage);
  // then
  assert.equal(email.inlineParts.length, 5);
  assert.equal(email.inlineParts[0].contentId, 'large@fixture');
  assert.equal(email.inlineParts[1].contentId, 'second');
  assert.equal(email.inlineParts[4].contentId, undefined);
  assert.ok(largePng.length > 3 * 1024 * 1024);
  assert.deepEqual(email.inlineParts[0].content, largePng);
  assert.equal(email.attachments.length, 1);
  assert.equal(email.attachments[0].filename, 'fixture.bin');
  assert.deepEqual(email.attachments[0].content, Buffer.from([0, 1, 255]));
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
