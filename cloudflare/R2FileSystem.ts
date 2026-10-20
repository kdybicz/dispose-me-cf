import { Buffer } from 'node:buffer';

import type { R2Bucket } from '@cloudflare/workers-types';

export class R2FileSystem {
  constructor(protected bucket: R2Bucket) {}

  async getObject(id: string): Promise<Buffer> {
    const object = await this.bucket.get(id);
    if (!object) {
      throw new Error('Email content not found');
    }
    return Buffer.from(await object.arrayBuffer());
  }

  async getObjects(ids: string[]): Promise<Buffer[]> {
    return Promise.all(ids.map((id) => this.getObject(id)));
  }
}
