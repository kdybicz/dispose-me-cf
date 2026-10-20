import sanitizeHtml from 'sanitize-html';
import {
  isInlineImageType,
  normalizeContentId,
  type ParsedEmail,
} from '../../cloudflare/EmailParser';

/** Email HTML is untrusted. Only generated, authenticated CID image URLs survive. */
export const renderEmailBody = (
  email: ParsedEmail,
  resourceUrl: (part: number) => string,
): string => {
  const images = new Map<string, string>();
  for (const part of email.inlineParts) {
    if (part.contentId && isInlineImageType(part.contentType) && !images.has(part.contentId)) {
      images.set(part.contentId, resourceUrl(part.part));
    }
  }
  return sanitizeHtml(email.body, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      img: (_tagName, attributes) => {
        let src: string | undefined;
        if (/^cid:/i.test(attributes.src ?? '')) {
          try {
            src = images.get(normalizeContentId(decodeURIComponent(attributes.src.slice(4))));
          } catch {
            // Malformed percent escapes cannot identify a MIME part.
          }
        }
        return { tagName: 'img', attribs: { ...attributes, src: src ?? '' } };
      },
    },
  });
};
