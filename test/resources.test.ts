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
  emailParser: new EmailParser(),
  fileSystem: {
    getObject: async () => {
      throw new Error('Unexpected buffered read');
    },
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
  deps.fileSystem.getObject = async () => {
    throw new EmailReadLimitError();
  };
  deps.emailParser.parseEmail = async () => {
    throw new Error('Unexpected MIME parsing');
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
  deps.fileSystem.getObject = async () => Buffer.alloc(100);
  deps.emailParser.parseEmail = async () => ({ ...parsed, body: 'é'.repeat(1024 * 1024) });
  const origin = await serve(context, deps);
  // when
  const response = await fetch(`${origin}/inbox/synthetic/feed/?x-api-key=${token}`);
  // then
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { message: RSS_LIMIT_MESSAGE });
});
