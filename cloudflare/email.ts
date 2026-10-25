import { Buffer } from 'node:buffer';

import type { ForwardableEmailMessage } from '@cloudflare/workers-types';

import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '../service/tools/const';
import log from '../service/tools/log';
import { normalizeUsername } from '../service/tools/utils';
import { EmailDatabase } from './EmailDatabase';
import { createEmailStore } from './EmailStore';
import type { Env } from './env';

export const receiveEmail = async (message: ForwardableEmailMessage, env: Env): Promise<void> => {
  const separator = message.to.lastIndexOf('@');
  const localPart = message.to.slice(0, separator);
  const domain = message.to.slice(separator + 1).toLowerCase();
  if (separator < 0 || !/^[a-zA-Z0-9.\-_+]+$/.test(localPart)) {
    message.setReject('Recipient is not allowed');
    return;
  }
  const username = normalizeUsername(localPart);
  const blacklist = env.INBOX_BLACKLIST.split(',').map((name) => normalizeUsername(name.trim()));
  if (
    domain !== env.DOMAIN_NAME.toLowerCase() ||
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH ||
    blacklist.includes(username)
  ) {
    message.setReject('Recipient is not allowed');
    return;
  }

  const ttlDays = Number(env.EMAIL_TTL_DAYS);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('EMAIL_TTL_DAYS must be positive');
  }

  try {
    const receivedAt = Math.floor(Date.now() / 1000);
    const raw = await new Response(message.raw as ReadableStream<Uint8Array>).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const id = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const email = await createEmailStore(env).receive(id, Buffer.from(raw));
    // Identical MIME content and its derived parts are shared across recipients.
    await new EmailDatabase(env.DB).store({
      Id: id,
      Username: username,
      Sender: email.from?.address ?? message.from,
      Subject: email.subject,
      ReceivedAt: receivedAt,
      ExpireAt: receivedAt + Math.floor(ttlDays * 86400),
      HasAttachments: Number(email.attachments.length > 0),
    });
  } catch (error) {
    log.error('Failed to receive email', error);
    throw error;
  }
};
