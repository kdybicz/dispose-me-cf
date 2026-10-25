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

export class R2FileSystem {
  constructor(protected bucket: R2Bucket) {}

  async getObject(id: string, maxBytes?: number): Promise<Buffer> {
    const object = await this.bucket.get(id);
    if (!object) {
      throw new Error('Email content not found');
    }
    if (maxBytes !== undefined && object.size > maxBytes) {
      await object.body.cancel();
      throw new EmailReadLimitError();
    }
    return Buffer.from(await object.arrayBuffer());
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
