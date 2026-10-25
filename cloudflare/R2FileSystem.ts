import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { R2Bucket } from '@cloudflare/workers-types';

export class EmailReadLimitError extends Error {
  constructor() {
    super('Email exceeds the requested read budget');
  }
}

export interface EmailObjectStream {
  body: Readable;
  size: number;
}

export interface EmailObject {
  content: Buffer;
  uploaded: Date;
}

export class R2FileSystem {
  constructor(protected bucket: R2Bucket) {}

  async getObject(id: string, maxBytes?: number): Promise<Buffer> {
    return (await this.readObject(id, maxBytes)).content;
  }

  async readObject(id: string, maxBytes?: number): Promise<EmailObject> {
    const object = await this.bucket.get(id);
    if (!object) {
      throw new Error('Email content not found');
    }
    if (maxBytes !== undefined && object.size > maxBytes) {
      await object.body.cancel();
      throw new EmailReadLimitError();
    }
    return { content: Buffer.from(await object.arrayBuffer()), uploaded: object.uploaded };
  }

  async putRawObject(id: string, content: Buffer): Promise<EmailObject> {
    const object = await this.bucket.put(id, content, {
      httpMetadata: { contentType: 'message/rfc822' },
    });
    if (!object) throw new Error('Failed to store raw email');
    return { content, uploaded: object.uploaded };
  }

  async putObject(key: string, content: Buffer | string, contentType: string): Promise<void> {
    const object = await this.bucket.put(key, content, { httpMetadata: { contentType } });
    if (!object) throw new Error('Failed to store derived email object');
  }

  async getJsonObject<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(key);
    return object ? object.json<T>() : null;
  }

  /** One bounded cleanup batch; the index stays until the generation is fully removed. */
  async deletePrefixBatch(prefix: string): Promise<boolean> {
    const page = await this.bucket.list({ prefix, limit: 1000 });
    if (page.objects.length) await this.bucket.delete(page.objects.map((object) => object.key));
    return !page.truncated;
  }

  async getObjectStream(id: string): Promise<EmailObjectStream> {
    const object = await this.bucket.get(id);
    if (!object) {
      throw new Error('Email content not found');
    }
    return {
      body: Readable.fromWeb(object.body as unknown as NodeReadableStream<Uint8Array>),
      size: object.size,
    };
  }
}
