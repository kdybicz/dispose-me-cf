import { pipeline } from 'node:stream/promises';

import dayjs = require('dayjs');

import type { Request, Response } from 'express';
import { matchedData, type ValidationError, validationResult } from 'express-validator';
import type { EmailDatabase } from '../../cloudflare/EmailDatabase';
import {
  type InlinePartDetails,
  isInlineImageType,
  type ParsedEmail,
} from '../../cloudflare/EmailParser';
import type { EmailStore } from '../../cloudflare/EmailStore';
import { EmailReadLimitError, type R2FileSystem } from '../../cloudflare/R2FileSystem';
import { getCookieMaxAgeMs } from '../tools/config';
import { AUTH_COOKIE_KEY, AUTH_QUERY_KEY, REMEMBER_COOKIE_KEY } from '../tools/const';
import { renderEmailBody } from '../tools/emailBody';
import {
  buildEmailFeed,
  FeedResourceLimitError,
  mapEmailDetailsToFeedItem,
  RSS_LIMIT_MESSAGE,
} from '../tools/feed';
import log from '../tools/log';
import { getCookie, getToken, normalizeUsername } from '../tools/utils';
import { TYPE_DEFAULT } from '../tools/validators';

const logQuery = (req: Request): string => {
  const { [AUTH_QUERY_KEY]: _token, ...query } = req.query;
  return JSON.stringify(query);
};

export interface InboxListParams extends Record<string, string> {
  username: string;
}

export interface InboxEmailParams extends InboxListParams {
  id: string;
}

export interface InboxQuery extends Record<string, undefined | string> {
  limit?: string;
  sendAfter?: string;
  type?: 'html' | 'json';
  [AUTH_QUERY_KEY]?: string;
}

export interface InboxAuthBody {
  token: string;
  remember: string;
}

export interface InboxRequest<P = Record<string, string>, B = unknown>
  extends Request<P, unknown, B, InboxQuery> {}

// biome-ignore lint/suspicious/noConfusingVoidType: Express route handler may return void
export type InboxResponse = Promise<Response<unknown> | void>;

export type EmailListItem = {
  id: string;
  from: string;
  subject: string;
  received: Date;
  hasAttachments: boolean;
};

export type EmailDetails = ParsedEmail & {
  id: string;
  inlineParts: (InlinePartDetails & { url?: string })[];
};

export interface InboxDependencies {
  emailDatabase: Pick<EmailDatabase, 'list' | 'exists' | 'delete'>;
  emailStore: Pick<EmailStore, 'getEmail' | 'getInlineImage' | 'getAttachment'>;
  fileSystem: Pick<R2FileSystem, 'getObjectStream'>;
}

export class InboxController {
  protected emailDatabase: InboxDependencies['emailDatabase'];
  protected emailStore: InboxDependencies['emailStore'];
  protected fileSystem: InboxDependencies['fileSystem'];

  constructor(dependencies: InboxDependencies) {
    this.emailDatabase = dependencies.emailDatabase;
    this.emailStore = dependencies.emailStore;
    this.fileSystem = dependencies.fileSystem;
  }

  private presentEmail(parsed: ParsedEmail, id: string, username: string): EmailDetails {
    return {
      ...parsed,
      id,
      attachments: parsed.attachments.map(({ content: _content, ...metadata }) => metadata),
      inlineParts: parsed.inlineParts.map(({ content: _content, ...metadata }) => ({
        ...metadata,
        url: isInlineImageType(metadata.contentType)
          ? `/inbox/${encodeURIComponent(username)}/${id}/inline/${metadata.part}`
          : undefined,
      })),
    };
  }

  private viewerBody(email: EmailDetails, username: string, token: string | null): string {
    return renderEmailBody(email, (part) => {
      const query = token ? `?${new URLSearchParams({ [AUTH_QUERY_KEY]: token })}` : '';
      return `/inbox/${encodeURIComponent(username)}/${email.id}/inline/${part}${query}`;
    });
  }

  inlineImage = async (req: InboxRequest<InboxEmailParams>, res: Response): InboxResponse => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return this.render422Response(errors.array(), req, res);
    const { id, username, part } = matchedData<{
      id: string;
      username: string;
      part: number;
    }>(req);
    if (!(await this.emailDatabase.exists(normalizeUsername(username), id))) {
      return this.render404Response(req, res);
    }
    const image = await this.emailStore.getInlineImage(id, part);
    if (!image) {
      return this.render404Response(req, res);
    }
    res.set({
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // The viewer has an opaque sandbox origin. Authentication is still mandatory.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.type(image.contentType);
    res.set('Content-Length', String(image.size));
    await pipeline(image.body, res);
    return;
  };

  index = async (req: InboxRequest, res: Response): InboxResponse => {
    log.debug(`Action: 'index' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const { type = TYPE_DEFAULT } = matchedData<{ type?: string }>(req);

    const token = getCookie(req, AUTH_COOKIE_KEY);
    if (token) {
      return res.redirect('/inbox');
    }

    if (type === 'html') {
      return res.render('pages/index');
    }

    return res.json({});
  };

  auth = async (
    req: InboxRequest<Record<string, never>, InboxAuthBody>,
    res: Response,
  ): InboxResponse => {
    log.debug(`Action: 'auth' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).render('pages/index', { errors: errors.array() });
    }

    const { token, remember } = matchedData<{ token: string; remember: boolean }>(req);

    let maxAge: number | undefined;
    if (remember) {
      maxAge = getCookieMaxAgeMs();

      res.cookie(REMEMBER_COOKIE_KEY, true, {
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        maxAge,
      });
    }

    res.cookie(AUTH_COOKIE_KEY, token, {
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      maxAge,
    });

    return res.redirect('/inbox');
  };

  async logout(_req: Request, res: Response): InboxResponse {
    res.clearCookie(AUTH_COOKIE_KEY);
    res.clearCookie(REMEMBER_COOKIE_KEY);
    return res.redirect('/');
  }

  show = async (req: InboxRequest<InboxEmailParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'show' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const {
      id,
      type = TYPE_DEFAULT,
      username,
    } = matchedData<{ id: string; type?: string; username: string }>(req);

    let email: EmailDetails | undefined;

    const normalizedUsername = normalizeUsername(username);
    const existsForUser = await this.emailDatabase.exists(normalizedUsername, id);
    if (existsForUser) {
      const stored = await this.emailStore.getEmail(id);
      email = this.presentEmail(stored.email, id, normalizedUsername);

      if (type === 'html') {
        const token = getToken(req);
        return res.render('pages/email', {
          email,
          token,
          viewerBody: this.viewerBody(email, normalizedUsername, token),
        });
      }

      return res.json({ email });
    }

    return this.render404Response(req, res);
  };

  download = async (req: InboxRequest<InboxEmailParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'download' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const { id, username } = matchedData<{ id: string; username: string }>(req);

    const normalizedUsername = normalizeUsername(username);
    const existsForUser = await this.emailDatabase.exists(normalizedUsername, id);
    if (existsForUser) {
      const object = await this.fileSystem.getObjectStream(id);
      res.attachment(`${id}.eml`);
      res.type('application/octet-stream');
      res.set('Content-Length', String(object.size));
      await pipeline(object.body, res);
      return;
    }

    return this.render404Response(req, res);
  };

  downloadAttachment = async (
    req: InboxRequest<InboxEmailParams>,
    res: Response,
  ): InboxResponse => {
    log.debug(
      `Action: 'download attachment' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`,
    );

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const { id, username, filename } = matchedData<{
      id: string;
      username: string;
      filename: string;
    }>(req);

    const normalizedUsername = normalizeUsername(username);
    const existsForUser = await this.emailDatabase.exists(normalizedUsername, id);
    if (existsForUser) {
      const attachment = await this.emailStore.getAttachment(id, filename);

      if (!attachment) {
        return this.render500Response(new Error('Email attachment not found!'), req, res);
      }

      res.attachment(attachment.filename);
      res.type(attachment.contentType);

      res.set('Content-Length', String(attachment.size));
      await pipeline(attachment.body, res);
      return;
    }

    return this.render404Response(req, res);
  };

  delete = async (req: InboxRequest<InboxEmailParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'delete' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const { id, username } = matchedData<{ id: string; username: string }>(req);

    const normalizedUsername = normalizeUsername(username);
    const deletedFromDatabase = await this.emailDatabase.delete(normalizedUsername, id);
    if (deletedFromDatabase) {
      if (req.method === 'DELETE') {
        return res.status(204).end();
      }

      return res.redirect(
        `/inbox/${username}?${new URLSearchParams(req.query as Record<string, string>)}`,
      );
    }

    return this.render404Response(req, res);
  };

  latest = async (req: InboxRequest<InboxListParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'latest' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const {
      sentAfter,
      type = TYPE_DEFAULT,
      username,
    } = matchedData<{
      sentAfter?: number;
      type?: string;
      username: string;
    }>(req);

    let email: EmailDetails | undefined;

    const normalizedUsername = normalizeUsername(username);
    const latestEmail = await this.emailDatabase.list(normalizedUsername, sentAfter, 1);
    if (latestEmail.Items && latestEmail.Items.length > 0) {
      const messageId = latestEmail.Items[0].Id;
      const stored = await this.emailStore.getEmail(messageId);
      email = this.presentEmail(stored.email, messageId, normalizedUsername);
    }

    if (type === 'html') {
      const token = getToken(req);
      return res.render('pages/email', {
        email,
        token,
        viewerBody: email ? this.viewerBody(email, normalizedUsername, token) : '',
      });
    }

    return res.json({ email });
  };

  inbox = async (req: InboxRequest, res: Response): InboxResponse => {
    log.debug(`Action: 'inbox' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const { type = TYPE_DEFAULT } = matchedData<{ type?: string }>(req);

    if (type === 'html') {
      return res.render('pages/inbox');
    }

    return res.json({});
  };

  list = async (req: InboxRequest<InboxListParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'list' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res, 'pages/inbox');
    }

    const {
      limit,
      sentAfter,
      type = TYPE_DEFAULT,
      username,
    } = matchedData<{
      limit?: number;
      sentAfter?: number;
      type?: string;
      username: string;
    }>(req);

    const normalizedUsername = normalizeUsername(username);
    const emailObjectList = await this.emailDatabase.list(normalizedUsername, sentAfter, limit);

    const emails = (emailObjectList.Items ?? []).map<EmailListItem>((emailObject) => ({
      id: emailObject.Id,
      from: emailObject.Sender,
      subject: emailObject.Subject,
      received: dayjs.unix(emailObject.ReceivedAt).toDate(),
      hasAttachments: emailObject.HasAttachments,
    }));

    if (type === 'html') {
      const token = getToken(req);
      return res.render('pages/list', { emails, token });
    }

    return res.json({ emails });
  };

  listRss = async (req: InboxRequest<InboxListParams>, res: Response): InboxResponse => {
    log.debug(`Action: 'listRss' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return this.render422Response(errors.array(), req, res);
    }

    const { username } = matchedData<{ username: string }>(req);

    const normalizedUsername = normalizeUsername(username);
    const emailList = await this.emailDatabase.list(normalizedUsername);

    const emailNamesList = emailList.Items?.map((item) => item.Id) ?? [];
    const token = getToken(req) as string;
    try {
      const xml = await buildEmailFeed(
        emailNamesList,
        normalizedUsername,
        token,
        async (id, maxBytes) => {
          const { email, rawBytes } = await this.emailStore.getEmail(id, maxBytes);
          return {
            rawBytes,
            item: mapEmailDetailsToFeedItem({ ...email, id }, normalizedUsername, token),
          };
        },
      );
      return res.type('application/rss+xml').send(xml);
    } catch (error) {
      if (error instanceof EmailReadLimitError || error instanceof FeedResourceLimitError) {
        return res.status(413).json({ message: RSS_LIMIT_MESSAGE });
      }
      throw error;
    }
  };

  render403Response = (req: Request, res: Response): void => {
    log.debug(`Action: '403' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const { type = TYPE_DEFAULT } = req.query;

    if (type === 'html') {
      res.status(403).render('pages/403');
      return;
    }

    res.status(403).json({ message: 'You are not allowed to visit that page.' });
  };

  render404Response = (req: Request, res: Response): void => {
    log.debug(`Action: '404' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const { type = TYPE_DEFAULT } = req.query;

    if (type === 'html') {
      res.status(404).render('pages/404');
      return;
    }

    res.status(404).json({ message: 'The page you are looking for was not found.' });
  };

  render422Response = (
    errors: ValidationError[],
    req: Request,
    res: Response,
    view = 'pages/422',
  ): void => {
    log.debug(`Action: '422' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)}`);

    const { type = TYPE_DEFAULT } = req.query;

    if (type === 'html') {
      res.status(422).render(view, { errors });
      return;
    }

    res.status(422).json({ errors });
  };

  render500Response = (err: Error, req: Request, res: Response): void => {
    log.error(
      `Action: '500' Params: ${JSON.stringify(req.params)} Query: ${logQuery(req)} Error: ${err.message}`,
      err,
    );

    const { type = TYPE_DEFAULT } = req.query;

    const genericErrorMessage = 'An internal server error occurred. Please try again later.';

    if (type === 'html') {
      res.status(500).render('pages/error', { error: { message: genericErrorMessage } });
      return;
    }

    res.status(500).json({ message: genericErrorMessage });
  };
}
