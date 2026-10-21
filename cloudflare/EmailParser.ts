import { Buffer } from 'node:buffer';

import PostalMime, { type Address } from 'postal-mime';

export interface EmailAddress {
  address: string;
  user: string | null;
  host: string | null;
  displayName: string;
  format(): string;
}

export interface AttachmentDetails {
  filename?: string;
  size: number;
  contentType: string;
  content?: Buffer;
}

export interface ParsedEmail {
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
  received: Date;
  attachments: AttachmentDetails[];
  inlineParts: InlinePartDetails[];
}

export interface InlinePartDetails extends AttachmentDetails {
  part: number;
  contentId?: string;
}

export const normalizeContentId = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
};

export const isInlineImageType = (contentType: string): boolean =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(contentType);

const mapAddress = (address: Address): EmailAddress => {
  const value = address.address ?? '';
  const separator = value.lastIndexOf('@');
  return {
    address: value,
    user: separator < 0 ? null : value.slice(0, separator),
    host: separator < 0 ? null : value.slice(separator + 1).toLowerCase(),
    displayName: address.name ?? '',
    format: () => (address.name ? `${address.name} <${value}>` : value),
  };
};

export class EmailParser {
  async parseEmail(raw: string | Buffer): Promise<ParsedEmail> {
    const email = await PostalMime.parse(raw);
    const date = new Date(email.date ?? '');
    const parts = email.attachments.map((attachment, part) => {
      const content =
        typeof attachment.content === 'string'
          ? Buffer.from(attachment.content, 'utf8')
          : Buffer.from(attachment.content);
      return {
        part,
        disposition: attachment.disposition,
        contentId: attachment.contentId ? normalizeContentId(attachment.contentId) : undefined,
        filename: attachment.filename ?? undefined,
        size: content.byteLength,
        contentType: attachment.mimeType.toLowerCase(),
        content,
      };
    });
    return {
      from: email.from ? mapAddress(email.from) : mapAddress({ address: '', name: '' }),
      to: (email.to ?? []).map(mapAddress),
      cc: (email.cc ?? []).map(mapAddress),
      bcc: (email.bcc ?? []).map(mapAddress),
      subject: email.subject ?? '',
      body: email.html ?? email.text ?? '',
      received: Number.isNaN(date.getTime()) ? new Date(0) : date,
      attachments: parts
        .filter((part) => part.disposition === 'attachment')
        .map(({ filename, size, contentType, content }) => ({
          filename,
          size,
          contentType,
          content,
        })),
      inlineParts: parts
        .filter(
          (part) =>
            part.disposition !== 'attachment' ||
            Boolean(part.contentId && isInlineImageType(part.contentType)),
        )
        .map(({ disposition: _disposition, ...part }) => part),
    };
  }
}
