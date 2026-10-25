import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { EmailReadLimitError } from '../cloudflare/R2FileSystem';
import { emailStorageFixture } from './fixtures/emailStorage';
import { inlineMessage, largePng, smallPng } from './fixtures/inline';

const bytes = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

test('ingestion parses once and warm views, images, attachments, and feeds never read raw MIME again', async () => {
  // given
  const fixture = emailStorageFixture();
  const raw = Buffer.from(inlineMessage);
  const summary = await fixture.store.receive('synthetic', raw);
  // when: use fresh store instances to prove persistence, rather than an in-memory cache.
  fixture.reads.length = 0;
  const shown = await fixture.createStore().getEmail('synthetic');
  const image = await fixture.createStore().getInlineImage('synthetic', 0);
  const attachmentImage = await fixture.createStore().getInlineImage('synthetic', 6);
  const attachment = await fixture.createStore().getAttachment('synthetic', 'attached.png');
  const repeated = await fixture.createStore().getEmail('synthetic', raw.length);
  // then
  assert.equal(fixture.parses, 1);
  assert.ok(!fixture.reads.includes('synthetic'));
  assert.deepEqual(fixture.objects.get('synthetic')?.content, raw);
  assert.equal(summary.subject, 'Inline image regression');
  assert.equal(shown.email.from?.format(), 'sender@example.net');
  assert.ok(shown.email.body.includes('cid:large%40fixture'));
  assert.equal(shown.email.received.toISOString(), '1970-01-01T00:00:00.000Z');
  assert.equal(shown.rawBytes, raw.length);
  assert.equal(JSON.stringify(shown), JSON.stringify(repeated));
  assert.ok(image && attachmentImage && attachment);
  assert.deepEqual(await bytes(image.body), largePng);
  assert.deepEqual(await bytes(attachmentImage.body), smallPng);
  assert.deepEqual(await bytes(attachment.body), smallPng);
  assert.ok(shown.email.attachments.every((part) => part.content === undefined));
  assert.ok(shown.email.inlineParts.every((part) => part.content === undefined));
  assert.ok(!JSON.stringify(shown.email).includes('storageIndex'));
  assert.ok(!JSON.stringify(shown.email).includes('generation'));
  // Four attachments and five other inline parts: the dual-purpose PNG is stored only once.
  assert.equal(fixture.writes.filter((key) => key.includes('/parts/')).length, 9);
  assert.equal(await fixture.store.getInlineImage('synthetic', 3), undefined);
  assert.equal(await fixture.store.getInlineImage('synthetic', 7), undefined);
  assert.equal(await fixture.store.getInlineImage('synthetic', 8), undefined);
  assert.equal(await fixture.store.getAttachment('synthetic', 'missing.bin'), undefined);
});

test('legacy messages convert lazily while retaining charset, formatting, and source expiry', async () => {
  // given
  const fixture = emailStorageFixture();
  const raw = Buffer.concat([
    Buffer.from(
      'From: Sender <sender@example.net>\r\nSubject: Legacy\r\n' +
        'Content-Type: text/plain; charset=windows-1252\r\n\r\ncaf',
    ),
    Buffer.from([0xe9]),
  ]);
  fixture.putLegacy('legacy', raw, 3600);
  // when
  const first = await fixture.store.getEmail('legacy');
  const second = await fixture.createStore().getEmail('legacy');
  // then
  assert.equal(fixture.parses, 1);
  assert.equal(fixture.reads.filter((key) => key === 'legacy').length, 1);
  assert.equal(first.email.body, 'café\n');
  assert.equal(first.email.from?.format(), 'Sender <sender@example.net>');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal([...fixture.rows.values()][0].ExpireAt, fixture.now + 86400 - 3600);
  assert.deepEqual(fixture.objects.get('legacy')?.content, raw);
});

test('warm resource requests load only the manifest and selected part, not the body or raw MIME', async () => {
  // given
  const fixture = emailStorageFixture();
  await fixture.store.receive('resources', Buffer.from(inlineMessage));
  fixture.reads.length = 0;
  // when
  const image = await fixture.createStore().getInlineImage('resources', 6);
  // then
  assert.ok(image);
  assert.deepEqual(await bytes(image.body), smallPng);
  assert.equal(fixture.reads.length, 2);
  assert.ok(fixture.reads[0].endsWith('/manifest.json'));
  assert.ok(fixture.reads[1].includes('/parts/'));
  assert.equal(fixture.parses, 1);
});

test('duplicate deliveries share a complete generation without parsing again', async () => {
  // given
  const fixture = emailStorageFixture();
  const raw = Buffer.from(inlineMessage);
  await fixture.store.receive('duplicate', raw);
  fixture.now += 60;
  // when
  await fixture.createStore().receive('duplicate', raw);
  // then
  assert.equal(fixture.parses, 1);
  assert.equal(fixture.publications.length, 1);
  assert.equal(fixture.rows.size, 1);
  assert.deepEqual(fixture.objects.get('duplicate')?.content, raw);
});

test('an existing message can lazily convert through an image request before its first view', async () => {
  // given
  const fixture = emailStorageFixture();
  fixture.putLegacy('imagefirst', Buffer.from(inlineMessage));
  // when
  const image = await fixture.store.getInlineImage('imagefirst', 0);
  await fixture.createStore().getEmail('imagefirst');
  // then
  assert.ok(image);
  assert.deepEqual(await bytes(image.body), largePng);
  assert.equal(fixture.parses, 1);
  assert.equal(fixture.reads.filter((key) => key === 'imagefirst').length, 1);
});

for (const failure of ['part', 'body', 'manifest', 'publication']) {
  test(`a failed ${failure} write is unpublished and the next request retries with a complete generation`, async () => {
    // given
    const fixture = emailStorageFixture();
    fixture.putLegacy('retry', Buffer.from(inlineMessage));
    fixture.failWrite = (key) =>
      failure === 'part'
        ? key.includes('/parts/')
        : failure === 'body'
          ? key.endsWith('/body')
          : failure === 'manifest' && key.endsWith('/manifest.json');
    fixture.failPublish = failure === 'publication';
    // when / then
    await assert.rejects(fixture.store.getEmail('retry'), /Synthetic/);
    assert.equal(fixture.publications.length, 0);
    assert.ok([...fixture.rows.values()].every((row) => !row.ready));
    fixture.failWrite = undefined;
    fixture.failPublish = false;
    await fixture.createStore().getEmail('retry');
    const image = await fixture.store.getInlineImage('retry', 0);
    assert.ok(image);
    assert.deepEqual(await bytes(image.body), largePng);
    assert.equal(fixture.parses, 2);
    assert.equal(fixture.publications.length, 1);
    assert.equal(fixture.rows.size, 2, 'Failed generations remain registered for cleanup');
  });
}

test('racing cold requests publish independent complete generations and warm reads do not parse', async () => {
  // given
  const fixture = emailStorageFixture();
  fixture.putLegacy('race', Buffer.from(inlineMessage));
  // when
  const results = await Promise.all([
    fixture.createStore().getEmail('race'),
    fixture.createStore().getEmail('race'),
  ]);
  const parses = fixture.parses;
  await fixture.createStore().getEmail('race');
  // then
  assert.equal(JSON.stringify(results[0]), JSON.stringify(results[1]));
  assert.equal(fixture.parses, parses);
  assert.equal(parses, 2);
  assert.equal(new Set(fixture.publications).size, 2);
});

test('cold and warm RSS source budgets reject before MIME parsing or body loading', async () => {
  // given
  const fixture = emailStorageFixture();
  const raw = Buffer.from('Subject: Budget\r\n\r\nBody');
  fixture.putLegacy('budget', raw);
  // when / then
  await assert.rejects(fixture.store.getEmail('budget', raw.length - 1), EmailReadLimitError);
  assert.equal(fixture.parses, 0);
  await fixture.store.getEmail('budget', raw.length);
  fixture.reads.length = 0;
  await assert.rejects(
    fixture.createStore().getEmail('budget', raw.length - 1),
    EmailReadLimitError,
  );
  assert.equal(fixture.parses, 1);
  assert.ok(fixture.reads.every((key) => key.endsWith('/manifest.json')));
});

test('a missing published manifest is invalidated and safely rebuilt from original MIME', async () => {
  // given
  const fixture = emailStorageFixture();
  await fixture.store.receive('repair', Buffer.from(inlineMessage));
  const manifestKey = [...fixture.objects.keys()].find((key) => key.endsWith('/manifest.json'));
  assert.ok(manifestKey);
  fixture.objects.delete(manifestKey);
  // when
  await fixture.createStore().getEmail('repair');
  // then
  assert.equal(fixture.parses, 2);
  assert.equal([...fixture.rows.values()].filter((row) => row.ready).length, 1);
});

test('expired derived data is unreadable and cleanup preserves raw MIME and newer deliveries', async () => {
  // given
  const fixture = emailStorageFixture();
  const raw = Buffer.from(inlineMessage);
  await fixture.store.receive('shared', raw);
  const original = [...fixture.rows.values()][0];
  fixture.now += 86400;
  await assert.rejects(fixture.store.getEmail('shared'), /retention has expired/);
  // when: a later identical delivery creates a new source lifetime and generation.
  await fixture.store.receive('shared', raw);
  await fixture.store.cleanupExpired();
  const image = await fixture.createStore().getInlineImage('shared', 0);
  // then
  assert.ok(image);
  assert.deepEqual(await bytes(image.body), largePng);
  assert.ok(![...fixture.objects.keys()].some((key) => key.includes(original.Generation)));
  assert.ok(fixture.objects.has('shared'));
  assert.equal(fixture.rows.size, 1);
  assert.ok([...fixture.rows.values()][0].ExpireAt > fixture.now);
});

test('cleanup resumes large prefixes in bounded batches and includes failed generations', async () => {
  // given
  const fixture = emailStorageFixture();
  const generation = { Id: 'orphan', Version: 1, Generation: 'failed', ExpireAt: fixture.now - 1 };
  await fixture.index.reserve(generation);
  const prefix = 'parsed/v1/orphan/failed/';
  for (let index = 0; index < 1001; index++) {
    fixture.objects.set(`${prefix}parts/${index}`, {
      content: Buffer.alloc(1),
      uploaded: new Date(),
    });
  }
  // when / then
  await fixture.store.cleanupExpired();
  assert.equal(fixture.objects.size, 1);
  assert.equal(fixture.rows.size, 1);
  await fixture.store.cleanupExpired();
  assert.equal(fixture.objects.size, 0);
  assert.equal(fixture.rows.size, 0);
});

test('a conversion that crosses source expiration never publishes its manifest', async () => {
  // given
  const fixture = emailStorageFixture();
  fixture.putLegacy('deadline', Buffer.from(inlineMessage), 86399);
  fixture.failWrite = (key) => {
    if (key.endsWith('/manifest.json')) fixture.now += 1;
    return false;
  };
  // when / then
  await assert.rejects(fixture.store.getEmail('deadline'), /retention has expired/);
  assert.equal(fixture.publications.length, 0);
  assert.ok([...fixture.rows.values()].every((row) => !row.ready));
  await fixture.store.cleanupExpired();
  assert.equal(fixture.rows.size, 0);
  assert.ok([...fixture.objects.keys()].every((key) => !key.startsWith('parsed/')));
});
