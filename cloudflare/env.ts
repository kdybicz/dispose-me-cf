import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  EMAILS: R2Bucket;
  DOMAIN_NAME: string;
  EMAIL_TTL_DAYS: string;
  INBOX_BLACKLIST: string;
  PRIVATE_ACCESS: string;
  ACCESS_TOKEN?: string;
}
