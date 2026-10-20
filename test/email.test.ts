import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import type { D1Database, ForwardableEmailMessage, R2Bucket } from '@cloudflare/workers-types';
import { EmailParser } from '../cloudflare/EmailParser';
import { receiveEmail } from '../cloudflare/email';
import type { Env } from '../cloudflare/env';
import { normalizeUsername } from '../service/tools/utils';

test('parses original charset bytes without corrupting text', async () => {
  // given
  const raw = Buffer.concat([
    Buffer.from(
      'From: Sender <sender@example.net>\r\nTo: user@example.com\r\n' +
        'Subject: Charset\r\nContent-Type: text/plain; charset=windows-1252\r\n\r\ncaf',
    ),
    Buffer.from([0xe9]),
  ]);
  // when
  const email = await new EmailParser().parseEmail(raw);
  // then
  assert.equal(email.body, 'café\n');
  assert.equal(email.from?.format(), 'Sender <sender@example.net>');
  assert.equal(email.to[0].user, 'user');
});

test('decodes a binary MIME attachment and retains the HTML body', async () => {
  // given
  const raw = [
    'From: sender@example.net',
    'To: user@example.com',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="fixture"',
    '',
    '--fixture',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello</p>',
    '--fixture',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="fixture.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    'AAEC//4=',
    '--fixture--',
    '',
  ].join('\r\n');
  // when
  const email = await new EmailParser().parseEmail(raw);
  // then
  assert.ok(email.body.includes('<p>Hello</p>'));
  assert.equal(email.attachments[0].filename, 'fixture.bin');
  assert.deepEqual(email.attachments[0].content, Buffer.from([0, 1, 2, 255, 254]));
});

for (const to of [
  'admin@example.com',
  'a.d.m.i.n+tag@example.com',
  'bad%name@example.com',
  'ab@example.com',
  'user@other.example',
]) {
  test(`rejects ${to} before accessing either storage service`, async () => {
    // given
    let rejected = '';
    const message = {
      to,
      setReject: (reason: string) => {
        rejected = reason;
      },
    } as ForwardableEmailMessage;
    const env: Env = {
      DOMAIN_NAME: 'example.com',
      INBOX_BLACKLIST: 'admin',
      EMAIL_TTL_DAYS: '1',
      PRIVATE_ACCESS: 'true',
      DB: new Proxy(
        {},
        {
          get: () => {
            throw new Error('Unexpected D1 access');
          },
        },
      ) as D1Database,
      EMAILS: new Proxy(
        {},
        {
          get: () => {
            throw new Error('Unexpected R2 access');
          },
        },
      ) as R2Bucket,
    };
    // when
    await receiveEmail(message, env);
    // then
    assert.equal(rejected, 'Recipient is not allowed');
  });
}

test('normalization preserves literal hyphens/underscores while collapsing dots and plus tags', () => {
  // given / when / then
  assert.equal(normalizeUsername('User.Name+tag'), 'username');
  assert.equal(normalizeUsername('USER-NAME_test'), 'user-name_test');
});
