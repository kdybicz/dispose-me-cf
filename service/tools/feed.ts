import { Buffer } from 'node:buffer';
import { type Author, Feed, type Item } from 'feed';
import type { EmailAddress } from '../../cloudflare/EmailParser';
import type { EmailDetails } from '../api/InboxController';
import { AUTH_QUERY_KEY } from './const';

export const RSS_MAX_RAW_BYTES = 25 * 1024 * 1024;
export const RSS_MAX_ITEM_BYTES = 1024 * 1024;
export const RSS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const RSS_LIMIT_MESSAGE =
  'RSS resource limit exceeded. Use the inbox and message endpoints to access the full content.';

export class FeedResourceLimitError extends Error {
  constructor() {
    super(RSS_LIMIT_MESSAGE);
  }
}

export type EmailFeedItem = Pick<
  Item,
  'id' | 'title' | 'link' | 'date' | 'content' | 'author' | 'contributor'
>;

export interface LoadedFeedItem {
  rawBytes: number;
  item: EmailFeedItem;
}

export const mapEmailAddressToAuthor = (address: null | EmailAddress): Author => ({
  name: address?.displayName ?? '',
  email: address?.address ?? '',
});

export const mapEmailDetailsToFeedItem = (
  email: EmailDetails,
  username: string,
  token: string,
): EmailFeedItem => ({
  id: email.id,
  title: email.subject,
  link: `https://${process.env.DOMAIN_NAME}/inbox/${username}/${email.id}?${AUTH_QUERY_KEY}=${token}`,
  content: email.body,
  author: [mapEmailAddressToAuthor(email.from)],
  contributor: email.to.concat(email.cc).concat(email.bcc).map(mapEmailAddressToAuthor),
  date: email.received,
});

const createFeed = (username: string, token: string, updated: Date): Feed => {
  return new Feed({
    id: `https://${process.env.DOMAIN_NAME}/`,
    title: 'Dispose Me - Cloudflare',
    description: 'Cloudflare-hosted disposable email service.',
    link: `https://${process.env.DOMAIN_NAME}/inbox/${username}?${AUTH_QUERY_KEY}=${token}`,
    copyright: 'Dispose Me - Cloudflare',
    updated,
    generator: 'Dispose Me - Cloudflare',
  });
};

const itemTextBytes = (item: EmailFeedItem): number => {
  const fields = [item.id ?? '', item.title, item.link, item.content ?? ''];
  for (const author of [...(item.author ?? []), ...(item.contributor ?? [])]) {
    fields.push(author.name ?? '', author.email ?? '', author.link ?? '');
  }
  return fields.reduce((bytes, text) => bytes + Buffer.byteLength(text, 'utf8'), 0);
};

/** Load one message at a time; retain feed items, never raw MIME or decoded attachments. */
export const buildEmailFeed = async (
  ids: string[],
  username: string,
  token: string,
  loadItem: (id: string, remainingRawBytes: number) => Promise<LoadedFeedItem>,
): Promise<string> => {
  let remainingRawBytes = RSS_MAX_RAW_BYTES;
  let remainingItemBytes = RSS_MAX_ITEM_BYTES;
  let feed: Feed | undefined;
  for (const id of ids) {
    if (remainingRawBytes <= 0) throw new FeedResourceLimitError();
    const { item, rawBytes } = await loadItem(id, remainingRawBytes);
    if (rawBytes > remainingRawBytes || itemTextBytes(item) > remainingItemBytes) {
      throw new FeedResourceLimitError();
    }
    // Includes JSON escaping and structural overhead, after rejecting oversized text
    // without first allocating another message-sized serialization.
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (itemBytes > remainingItemBytes) throw new FeedResourceLimitError();
    remainingRawBytes -= rawBytes;
    remainingItemBytes -= itemBytes;
    feed ??= createFeed(username, token, item.date);
    feed.addItem(item);
  }
  const xml = (feed ?? createFeed(username, token, new Date())).rss2();
  if (Buffer.byteLength(xml, 'utf8') > RSS_MAX_OUTPUT_BYTES) {
    throw new FeedResourceLimitError();
  }
  return xml;
};
