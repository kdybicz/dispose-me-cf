import type { NextFunction, Request, Response } from 'express';

import express = require('express');

import type { ValidationChain } from 'express-validator';
import helmet from 'helmet';
import log from '../tools/log';
import {
  buildDeleteEmailValidationChain,
  buildDownloadEmailAttachmentValidationChain,
  buildDownloadEmailValidationChain,
  buildInboxValidationChain,
  buildIndexValidationChain,
  buildInlineImageValidationChain,
  buildLatestEmailValidationChain,
  buildListEmailsValidationChain,
  buildListRssValidationChain,
  buildShowEmailValidationChain,
} from '../tools/validators';
import type { InboxController } from './InboxController';

export const createApp = (
  inboxController: InboxController,
  configure: (app: express.Express) => void,
  authValidation: ValidationChain[],
): express.Express => {
  const assetDomain = process.env.ASSET_DOMAIN ?? '';
  const app = express();

  // Security best practices for Express apps
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdnjs.cloudflare.com',
            'https://chancejs.com',
          ],
          connectSrc: ["'self'", 'https://chancejs.com'],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
            ...(assetDomain ? [`https://${assetDomain}`] : []),
          ],
          fontSrc: [
            "'self'",
            'https://fonts.gstatic.com',
            ...(assetDomain ? [`https://${assetDomain}`] : []),
          ],
          imgSrc: ["'self'", 'data:', ...(assetDomain ? [`https://${assetDomain}`] : [])],
        },
      },
    }),
  );
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json());
  app.use(
    express.urlencoded({
      extended: true,
    }),
  );

  // provide req properties to be used in EJS templates
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.query = req.query;
    res.locals.url = req.originalUrl;
    res.locals.req = req;
    res.locals.assetDomain = assetDomain;

    next();
  });

  app.set('view engine', 'ejs');
  configure(app);

  app.get('/', ...buildIndexValidationChain(), inboxController.index);
  app.post('/', ...authValidation, inboxController.auth);
  app.get('/logout', inboxController.logout);

  app.get('/inbox/:username/latest', ...buildLatestEmailValidationChain(), inboxController.latest);
  app.get('/inbox/:username/feed/', ...buildListRssValidationChain(), inboxController.listRss);
  app.get(
    '/inbox/:username/:id/delete',
    ...buildDeleteEmailValidationChain(),
    inboxController.delete,
  );
  app.delete(
    '/inbox/:username/:id/delete',
    ...buildDeleteEmailValidationChain(),
    inboxController.delete,
  );
  app.get(
    '/inbox/:username/:id/download',
    ...buildDownloadEmailValidationChain(),
    inboxController.download,
  );
  app.get(
    '/inbox/:username/:id/attachment',
    ...buildDownloadEmailAttachmentValidationChain(),
    inboxController.downloadAttachment,
  );
  app.get('/inbox/:username/:id', ...buildShowEmailValidationChain(), inboxController.show);
  app.get(
    '/inbox/:username/:id/inline/:part',
    ...buildInlineImageValidationChain(),
    inboxController.inlineImage,
  );
  app.get('/inbox/:username', ...buildListEmailsValidationChain(), inboxController.list);
  app.get('/inbox', ...buildInboxValidationChain(), inboxController.inbox);

  app.use((req: Request, res: Response, _: NextFunction) => {
    inboxController.render404Response(req, res);
  });

  app.use((err: Error, req: Request, res: Response, _: NextFunction) => {
    log.error('Error while processing request', err);
    inboxController.render500Response(err, req, res);
  });

  return app;
};
