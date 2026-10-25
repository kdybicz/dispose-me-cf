import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { EmailParser } from '../cloudflare/EmailParser';
import { EmailReadLimitError } from '../cloudflare/R2FileSystem';
import { createApp } from '../service/api/app';
import { InboxController, type InboxDependencies } from '../service/api/InboxController';
import { RSS_LIMIT_MESSAGE } from '../service/tools/feed';
import { emailStorageFixture } from './fixtures/emailStorage';
import { inlineMessage, smallPng } from './fixtures/inline';

const token = 'syntheticresourcetesttoken';
const dependencies = (): InboxDependencies => ({
  emailDatabase: {
    exists: async (username, id) => username === 'synthetic' && id === 'abc123',
    list: async () => ({
      Items: [
        {
          Id: 'abc123',
          Username: 'synthetic',
          Sender: 'sender@example.net',
          Subject: 'Test',
          ReceivedAt: 1,
          ExpireAt: 9999999999,
          HasAttachments: false,
        },
      ],
    }),
    delete: async () => false,
  },
  emailStore: {
    getEmail: async () => {
      throw new Error('Unexpected parsed message read');
    },
    getInlineImage: async () => {
      throw new Error('Unexpected inline image read');
    },
    getAttachment: async () => {
      throw new Error('Unexpected attachment read');
    },
  },
  fileSystem: {
    getObjectStream: async () => {
      throw new Error('Unexpected stream read');
    },
  },
});

const serve = async (context: TestContext, deps: InboxDependencies): Promise<string> => {
  const app = createApp(new InboxController(deps), () => {}, []);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};

test('raw download streams original binary bytes and checks membership before storage', async (context) => {
  // given
  const deps = dependencies();
  const raw = Buffer.from([0, 1, 128, 255, 13, 10]);
  let reads = 0;
  deps.fileSystem.getObjectStream = async () => {
    reads++;
    return { body: Readable.from([raw.subarray(0, 3), raw.subarray(3)]), size: raw.length };
  };
  const origin = await serve(context, deps);
  // when / then
  const denied = await fetch(`${origin}/inbox/unrelated/abc123/download?type=json`);
  assert.equal(denied.status, 404);
  assert.equal(reads, 0);
  const response = await fetch(`${origin}/inbox/synthetic/abc123/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(raw.length));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.ok(response.headers.get('content-disposition')?.includes('abc123.eml'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
  assert.equal(reads, 1);
});

test('RSS turns a storage read-budget failure into an explicit 413 without parsing', async (context) => {
  // given
  const deps = dependencies();
  deps.emailStore.getEmail = async () => {
    throw new EmailReadLimitError();
  };
  const origin = await serve(context, deps);
  // when
  const response = await fetch(`${origin}/inbox/synthetic/feed/?x-api-key=${token}`);
  // then
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { message: RSS_LIMIT_MESSAGE });
});

test('RSS rejects oversized parsed content instead of returning a truncated feed', async (context) => {
  // given
  const deps = dependencies();
  const parsed = await new EmailParser().parseEmail('Subject: Large\r\n\r\nBody');
  deps.emailStore.getEmail = async () => ({
    email: { ...parsed, body: 'é'.repeat(1024 * 1024) },
    rawBytes: 100,
  });
  const origin = await serve(context, deps);
  // when
  const response = await fetch(`${origin}/inbox/synthetic/feed/?x-api-key=${token}`);
  // then
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { message: RSS_LIMIT_MESSAGE });
});

test('warm message, image, attachment, and RSS routes reuse stored parts without parsing raw MIME', async (context) => {
  // given
  const fixture = emailStorageFixture();
  await fixture.store.receive('abc123', Buffer.from(inlineMessage));
  const deps = dependencies();
  deps.emailStore = fixture.createStore();
  const origin = await serve(context, deps);
  fixture.reads.length = 0;
  // when / then
  for (const path of [
    '/inbox/unrelated/abc123?type=json',
    '/inbox/unrelated/abc123/inline/6?type=json',
    '/inbox/unrelated/abc123/attachment?filename=attached.png&type=json',
  ]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  assert.equal(fixture.reads.length, 0, 'Membership must be checked before derived storage');
  const shown = (await (await fetch(`${origin}/inbox/synthetic/abc123?type=json`)).json()) as {
    email: { subject: string };
  };
  assert.equal(shown.email.subject, 'Inline image regression');
  assert.ok(!JSON.stringify(shown).includes('storageIndex'));
  assert.ok(!JSON.stringify(shown).includes('parsed/v1'));
  const image = await fetch(`${origin}/inbox/synthetic/abc123/inline/6`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), smallPng);
  const attachment = await fetch(
    `${origin}/inbox/synthetic/abc123/attachment?filename=attached.png`,
  );
  assert.ok(attachment.headers.get('content-disposition')?.startsWith('attachment;'));
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), smallPng);
  const rss = await fetch(`${origin}/inbox/synthetic/feed/?x-api-key=${token}`);
  assert.equal(rss.status, 200);
  assert.ok((await rss.text()).includes('Inline image regression'));
  assert.equal(fixture.parses, 1);
  assert.ok(!fixture.reads.includes('abc123'));
});
