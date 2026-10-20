import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { EmailParser } from '../cloudflare/EmailParser';
import { mapEmailDetailsListToFeed } from '../service/tools/feed';

test('RSS keeps the deployed domain, recipient metadata, body, and message links', async () => {
  // given
  const original = process.env.DOMAIN_NAME;
  process.env.DOMAIN_NAME = 'example.net';
  try {
    const email = await new EmailParser().parseEmail(
      [
        'From: Example Sender <sender@example.net>',
        'To: test@example.net',
        'Subject: RSS regression',
        'Date: Sun, 18 Oct 2026 12:00:00 +0000',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Mail body</p>',
        '',
      ].join('\r\n'),
    );
    // when
    const feed = mapEmailDetailsListToFeed(
      [{ ...email, id: 'abc123' }],
      'test',
      'testtoken1234567890123',
    ).rss2();
    // then
    assert.ok(feed.includes('RSS regression'));
    assert.ok(feed.includes('https://example.net/inbox/test/abc123?x-api-key='));
    assert.ok(feed.includes('sender@example.net'));
    assert.ok(feed.includes('Mail body'));
    assert.ok(feed.includes('Cloudflare-hosted'));
  } finally {
    if (original === undefined) delete process.env.DOMAIN_NAME;
    else process.env.DOMAIN_NAME = original;
  }
});
