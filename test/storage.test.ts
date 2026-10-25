import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import type { R2Bucket } from '@cloudflare/workers-types';
import { EmailReadLimitError, R2FileSystem } from '../cloudflare/R2FileSystem';

test('R2 rejects an oversized RSS read before buffering and cancels its body', async () => {
  // given
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
  });
  const fileSystem = new R2FileSystem({
    get: async () => ({
      size: 101,
      body,
      arrayBuffer: async () => {
        reads++;
        return new ArrayBuffer(101);
      },
    }),
  } as unknown as R2Bucket);
  // when / then
  await assert.rejects(fileSystem.getObject('synthetic', 100), EmailReadLimitError);
  assert.equal(cancelled, true);
  assert.equal(reads, 0);
});

test('R2 permits an object exactly at the remaining read budget', async () => {
  // given
  const bytes = Uint8Array.from([0, 255, 128]);
  const fileSystem = new R2FileSystem({
    get: async () => ({ size: 3, arrayBuffer: async () => bytes.buffer }),
  } as unknown as R2Bucket);
  // when / then
  assert.deepEqual(await fileSystem.getObject('synthetic', 3), Buffer.from(bytes));
});

test('R2 streams binary bytes with backpressure instead of buffering the whole object', async () => {
  // given
  const chunk = Buffer.alloc(64 * 1024, 0xa5);
  const totalChunks = 128;
  let produced = 0;
  let consumed = 0;
  let producedAtFirstWrite = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === totalChunks) controller.close();
      else {
        produced++;
        controller.enqueue(chunk);
      }
    },
  });
  const fileSystem = new R2FileSystem({
    get: async () => ({
      size: totalChunks * chunk.length,
      body,
      arrayBuffer: () => {
        throw new Error('Streaming downloads must not buffer');
      },
    }),
  } as unknown as R2Bucket);
  // when
  const object = await fileSystem.getObjectStream('synthetic');
  await pipeline(
    object.body,
    new Writable({
      highWaterMark: chunk.length,
      write(bytes: Buffer, _encoding, done) {
        if (consumed === 0) producedAtFirstWrite = produced;
        consumed += bytes.length;
        assert.deepEqual(bytes, chunk);
        setImmediate(done);
      },
    }),
  );
  // then
  assert.equal(object.size, totalChunks * chunk.length);
  assert.equal(consumed, object.size);
  assert.ok(producedAtFirstWrite < totalChunks, 'The first write precedes the full object read');
});

test('cancelling a raw download cancels the underlying R2 body', async () => {
  // given
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fileSystem = new R2FileSystem({
    get: async () => ({ size: 1024 * 1024, body }),
  } as unknown as R2Bucket);
  const object = await fileSystem.getObjectStream('synthetic');
  // when: the consumer disconnects after the first chunk.
  await assert.rejects(
    pipeline(
      object.body,
      new Writable({
        write(_chunk, _encoding, done) {
          done(new Error('Consumer disconnected'));
        },
      }),
    ),
    /Consumer disconnected/,
  );
  // then
  assert.equal(cancelled, true);
});
