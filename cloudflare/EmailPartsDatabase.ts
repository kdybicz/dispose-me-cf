import type { D1Database } from '@cloudflare/workers-types';

export interface EmailGeneration {
  Id: string;
  Version: number;
  Generation: string;
  ExpireAt: number;
}

export class EmailPartsDatabase {
  constructor(private database: D1Database) {}

  async findReady(id: string, version: number, now: number): Promise<EmailGeneration | null> {
    return this.database
      .prepare(`SELECT Id, Version, Generation, ExpireAt FROM email_derivatives
      WHERE Id = ? AND Version = ? AND Ready = 1 AND ExpireAt > ?
      ORDER BY ExpireAt DESC, Generation LIMIT 1`)
      .bind(id, version, now)
      .first<EmailGeneration>();
  }

  async reserve(generation: EmailGeneration): Promise<void> {
    await this.database
      .prepare(`INSERT INTO email_derivatives
      (Id, Version, Generation, ExpireAt, Ready) VALUES (?, ?, ?, ?, 0)`)
      .bind(generation.Id, generation.Version, generation.Generation, generation.ExpireAt)
      .run();
  }

  async publish(generation: EmailGeneration, now: number): Promise<void> {
    const result = await this.database
      .prepare(`UPDATE email_derivatives SET Ready = 1
      WHERE Id = ? AND Version = ? AND Generation = ? AND ExpireAt > ?`)
      .bind(generation.Id, generation.Version, generation.Generation, now)
      .run();
    if (result.meta.changes !== 1) throw new Error('Email conversion expired before publication');
  }

  async invalidate(generation: EmailGeneration): Promise<void> {
    await this.database
      .prepare(`UPDATE email_derivatives SET Ready = 0
      WHERE Id = ? AND Version = ? AND Generation = ?`)
      .bind(generation.Id, generation.Version, generation.Generation)
      .run();
  }

  async listExpired(now: number, limit = 100): Promise<EmailGeneration[]> {
    const { results } = await this.database
      .prepare(`SELECT Id, Version, Generation, ExpireAt
      FROM email_derivatives WHERE ExpireAt <= ? ORDER BY ExpireAt LIMIT ?`)
      .bind(now, limit)
      .all<EmailGeneration>();
    return results;
  }

  async deleteExpired(generation: EmailGeneration, now: number): Promise<void> {
    await this.database
      .prepare(`DELETE FROM email_derivatives
      WHERE Id = ? AND Version = ? AND Generation = ? AND ExpireAt <= ?`)
      .bind(generation.Id, generation.Version, generation.Generation, now)
      .run();
  }
}
