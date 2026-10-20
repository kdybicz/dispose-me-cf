import { posix } from 'node:path';

// Generated at build time so Workers never need eval or template-file access.
// @ts-expect-error Generated module is deliberately excluded from version control.
import { templates } from './generated/templates.js';

type Template = (
  locals: Record<string, unknown>,
  escapeFunction: (value: unknown) => string,
  include: (name: string, locals?: Record<string, unknown>) => string,
) => string;

const escapeHtml = (value: unknown): string => {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&#34;',
    "'": '&#39;',
  };
  return value == null ? '' : String(value).replace(/[&<>"']/g, (character) => entities[character]);
};

export const renderTemplate = (name: string, locals: Record<string, unknown>): string => {
  const key = name.replace(/\.ejs$/, '');
  const template = (templates as Record<string, Template>)[key];
  if (!template) {
    throw new Error(`Unknown template: ${key}`);
  }
  return template({ process, ...locals }, escapeHtml, (include, extra = {}) =>
    renderTemplate(posix.join(posix.dirname(key), include), { ...locals, ...extra }),
  );
};

export class BundledView {
  protected name: string;
  path: string;

  constructor(name: string) {
    this.name = name;
    this.path = name;
  }

  render(
    locals: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ): void {
    try {
      callback(null, renderTemplate(this.name, locals));
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Template rendering failed'));
    }
  }
}
