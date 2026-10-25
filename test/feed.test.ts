import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { EmailParser } from '../cloudflare/EmailParser';
import {
  buildEmailFeed,
  type EmailFeedItem,
  FeedResourceLimitError,
  mapEmailDetailsToFeedItem,
  RSS_MAX_ITEM_BYTES,
  RSS_MAX_RAW_BYTES,
} from '../service/tools/feed';

const item = (id: string, content = 'Body'): EmailFeedItem => ({
  id,
  title: `Subject ${id}`,
  content,
  link: `https://example.net/inbox/test/${id}`,
  date: new Date(0),
});

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
    const feed = await buildEmailFeed(['abc123'], 'test', 'testtoken1234567890123', async (id) => ({
      rawBytes: 1000,
      item: mapEmailDetailsToFeedItem({ ...email, id }, 'test', 'testtoken1234567890123'),
    }));
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

test('RSS loads sequentially and passes the remaining raw-byte budget to each read', async () => {
  // given
  let active = 0;
  let peak = 0;
  const budgets: number[] = [];
  // when
  const xml = await buildEmailFeed(
    ['first', 'second', 'third'],
    'test',
    'token',
    async (id, budget) => {
      active++;
      peak = Math.max(peak, active);
      budgets.push(budget);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { rawBytes: 100, item: item(id) };
    },
  );
  // then
  assert.equal(peak, 1);
  assert.deepEqual(budgets, [RSS_MAX_RAW_BYTES, RSS_MAX_RAW_BYTES - 100, RSS_MAX_RAW_BYTES - 200]);
  assert.ok(xml.indexOf('Subject first') < xml.indexOf('Subject second'));
  assert.ok(xml.indexOf('Subject second') < xml.indexOf('Subject third'));
});

test('RSS accepts the exact raw budget but stops before loading another message', async () => {
  // given
  const loaded: string[] = [];
  const load = async (id: string) => {
    loaded.push(id);
    return { rawBytes: RSS_MAX_RAW_BYTES, item: item(id) };
  };
  // when / then
  assert.ok((await buildEmailFeed(['first'], 'test', 'token', load)).includes('Subject first'));
  loaded.length = 0;
  await assert.rejects(
    buildEmailFeed(['first', 'second'], 'test', 'token', load),
    FeedResourceLimitError,
  );
  assert.deepEqual(loaded, ['first']);
});

test('RSS rejects a loader result exceeding the remaining raw budget', async () => {
  // given / when / then
  await assert.rejects(
    buildEmailFeed(['first'], 'test', 'token', async (id) => ({
      rawBytes: RSS_MAX_RAW_BYTES + 1,
      item: item(id),
    })),
    FeedResourceLimitError,
  );
});

test('RSS bounds cumulative retained item bytes, including UTF-8 text and metadata', async () => {
  // given
  const loaded: string[] = [];
  // when / then
  await assert.rejects(
    buildEmailFeed(['first', 'second', 'third'], 'test', 'token', async (id) => {
      loaded.push(id);
      return { rawBytes: 100, item: item(id, 'é'.repeat(RSS_MAX_ITEM_BYTES / 4)) };
    }),
    FeedResourceLimitError,
  );
  assert.deepEqual(loaded, ['first', 'second']);
  await assert.rejects(
    buildEmailFeed(['first'], 'test', 'token', async (id) => ({
      rawBytes: 100,
      item: { ...item(id), author: [{ name: 'é'.repeat(RSS_MAX_ITEM_BYTES), email: 'a@b.net' }] },
    })),
    FeedResourceLimitError,
  );
});

test('RSS accepts the exact item budget and rejects the next byte', async () => {
  // given
  const empty = item('first', '');
  const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const content = 'a'.repeat(RSS_MAX_ITEM_BYTES - overhead);
  // when / then
  assert.ok(
    (
      await buildEmailFeed(['first'], 'test', 'token', async (id) => ({
        rawBytes: content.length,
        item: item(id, content),
      }))
    ).includes(content),
  );
  await assert.rejects(
    buildEmailFeed(['first'], 'test', 'token', async (id) => ({
      rawBytes: content.length + 1,
      item: item(id, `${content}a`),
    })),
    FeedResourceLimitError,
  );
});

test('RSS rejects XML expansion beyond the output budget instead of returning a partial feed', async () => {
  // given: XML escaping expands a valid display name beyond 2 MiB.
  const author = { name: '&'.repeat(500_000), email: 'sender@example.net' };
  // when / then
  await assert.rejects(
    buildEmailFeed(['first'], 'test', 'token', async (id) => ({
      rawBytes: 600_000,
      item: { ...item(id), author: [author] },
    })),
    FeedResourceLimitError,
  );
});

test('an empty inbox produces an empty RSS feed without loading messages', async () => {
  // given / when
  const xml = await buildEmailFeed([], 'test', 'token', async () => {
    throw new Error('Unexpected object read');
  });
  // then
  assert.ok(xml.includes('<rss'));
  assert.ok(!xml.includes('<item>'));
});
