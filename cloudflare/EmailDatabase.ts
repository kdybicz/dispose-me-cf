import type { D1Database } from '@cloudflare/workers-types';

import { DEFAULT_EMAIL_LIMIT } from '../service/tools/const';

export interface EmailMetadata {
  Id: string;
  Username: string;
  Sender: string;
  Subject: string;
  ReceivedAt: number;
  ExpireAt: number;
  HasAttachments: number;
}

export interface InboxEmail extends Omit<EmailMetadata, 'HasAttachments'> {
  HasAttachments: boolean;
}

export interface EmailListResult {
  Items: InboxEmail[];
}

export class EmailDatabase {
  constructor(protected database: D1Database) {}

  async store(email: EmailMetadata): Promise<void> {
    await this.database
      .prepare(`INSERT INTO messages
        (Id, Username, Sender, Subject, ReceivedAt, ExpireAt, HasAttachments)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (Username, Id) DO UPDATE SET
        Sender = excluded.Sender, Subject = excluded.Subject,
        ReceivedAt = excluded.ReceivedAt, ExpireAt = excluded.ExpireAt,
        HasAttachments = excluded.HasAttachments
        WHERE messages.ExpireAt <= excluded.ReceivedAt`)
      .bind(
        email.Id,
        email.Username,
        email.Sender,
        email.Subject,
        email.ReceivedAt,
        email.ExpireAt,
        email.HasAttachments,
      )
      .run();
  }

  async list(
    username: string,
    sentAfter = 0,
    limit = DEFAULT_EMAIL_LIMIT,
  ): Promise<EmailListResult> {
    const { results } = await this.database
      .prepare(`SELECT * FROM messages WHERE Username = ? AND ReceivedAt > ? AND ExpireAt > ?
        ORDER BY ReceivedAt DESC, Id DESC LIMIT ?`)
      .bind(username, sentAfter, Math.floor(Date.now() / 1000), limit)
      .all<EmailMetadata>();
    return {
      Items: results.map((email) => ({ ...email, HasAttachments: Boolean(email.HasAttachments) })),
    };
  }

  async exists(username: string, id: string): Promise<boolean> {
    const result = await this.database
      .prepare('SELECT Id FROM messages WHERE Username = ? AND Id = ? AND ExpireAt > ?')
      .bind(username, id, Math.floor(Date.now() / 1000))
      .first();
    return result !== null;
  }

  async delete(username: string, id: string): Promise<boolean> {
    const result = await this.database
      .prepare('DELETE FROM messages WHERE Username = ? AND Id = ? AND ExpireAt > ?')
      .bind(username, id, Math.floor(Date.now() / 1000))
      .run();
    return result.meta.changes > 0;
  }

  async deleteExpired(): Promise<void> {
    await this.database
      .prepare(`DELETE FROM messages WHERE rowid IN
        (SELECT rowid FROM messages WHERE ExpireAt <= ? LIMIT 1000)`)
      .bind(Math.floor(Date.now() / 1000))
      .run();
  }
}
