import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import type { R2Bucket } from '@cloudflare/workers-types';
import { EmailParser } from '../../cloudflare/EmailParser';
import type { EmailGeneration } from '../../cloudflare/EmailPartsDatabase';
import { EmailStore } from '../../cloudflare/EmailStore';
import { R2FileSystem } from '../../cloudflare/R2FileSystem';

interface ObjectData {
  content: Buffer;
  uploaded: Date;
}

export const emailStorageFixture = () => {
  let now = 1_800_000_000;
  let parses = 0;
  const objects = new Map<string, ObjectData>();
  const rows = new Map<string, EmailGeneration & { ready: boolean }>();
  const reads: string[] = [];
  const writes: string[] = [];
  const publications: string[] = [];
  let failWrite: ((key: string) => boolean) | undefined;
  let failPublish = false;
  const index = {
    findReady: async (id: string, version: number, time: number) =>
      [...rows.values()].find(
        (row) => row.Id === id && row.Version === version && row.ready && row.ExpireAt > time,
      ) ?? null,
    reserve: async (generation: EmailGeneration) => {
      rows.set(generation.Generation, { ...generation, ready: false });
    },
    publish: async (generation: EmailGeneration, time: number) => {
      if (failPublish) throw new Error('Synthetic publication failure');
      const row = rows.get(generation.Generation);
      assert.ok(row && row.ExpireAt > time);
      const prefix = `parsed/v${row.Version}/${row.Id}/${row.Generation}/`;
      const storedManifest = objects.get(`${prefix}manifest.json`);
      assert.ok(storedManifest);
      const manifest = JSON.parse(storedManifest.content.toString());
      assert.ok(objects.has(`${prefix}body`));
      for (const part of [...manifest.attachments, ...manifest.inlineParts]) {
        assert.ok(objects.has(`${prefix}parts/${part.storageIndex}`));
      }
      row.ready = true;
      publications.push(generation.Generation);
    },
    invalidate: async (generation: EmailGeneration) => {
      const row = rows.get(generation.Generation);
      if (row) row.ready = false;
    },
    listExpired: async (time: number, limit = 100) =>
      [...rows.values()].filter((row) => row.ExpireAt <= time).slice(0, limit),
    deleteExpired: async (generation: EmailGeneration, time: number) => {
      if ((rows.get(generation.Generation)?.ExpireAt ?? Infinity) <= time) {
        rows.delete(generation.Generation);
      }
    },
  };
  const bucket = {
    get: async (key: string) => {
      reads.push(key);
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.content.length,
        uploaded: object.uploaded,
        arrayBuffer: async () => Uint8Array.from(object.content).buffer,
        json: async () => JSON.parse(object.content.toString()),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(object.content);
            controller.close();
          },
        }),
      };
    },
    put: async (key: string, content: Buffer | string) => {
      writes.push(key);
      if (failWrite?.(key)) throw new Error('Synthetic object write failure');
      const object = { content: Buffer.from(content), uploaded: new Date(now * 1000) };
      objects.set(key, object);
      return { size: object.content.length, uploaded: object.uploaded };
    },
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return {
        objects: keys.slice(0, limit).map((key) => ({ key })),
        truncated: keys.length > limit,
      };
    },
    delete: async (keys: string[]) => {
      for (const key of keys) objects.delete(key);
    },
  } as unknown as R2Bucket;
  const fileSystem = new R2FileSystem(bucket);
  const parser = {
    parseEmail: async (raw: Buffer | string) => {
      parses++;
      return new EmailParser().parseEmail(raw);
    },
  };
  const createStore = () =>
    new EmailStore({
      fileSystem,
      index,
      parser,
      ttlSeconds: 86400,
      now: () => now,
    });
  return {
    objects,
    rows,
    reads,
    writes,
    publications,
    fileSystem,
    index,
    createStore,
    store: createStore(),
    get parses() {
      return parses;
    },
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    set failWrite(value: ((key: string) => boolean) | undefined) {
      failWrite = value;
    },
    set failPublish(value: boolean) {
      failPublish = value;
    },
    putLegacy(id: string, content: Buffer, age = 0) {
      objects.set(id, { content, uploaded: new Date((now - age) * 1000) });
    },
  };
};
