import { httpServerHandler } from 'cloudflare:node';

import { env } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import { body } from 'express-validator';
import { createApp } from '../service/api/app';
import { InboxController } from '../service/api/InboxController';
import { getToken } from '../service/tools/utils';
import { buildRememberBodyValidator } from '../service/tools/validators';
import { EmailDatabase } from './EmailDatabase';
import { EmailParser } from './EmailParser';
import { receiveEmail } from './email';
import type { Env } from './env';
import { R2FileSystem } from './R2FileSystem';
import { BundledView } from './templates';

const bindings = env as unknown as Env;
const isTokenValid = (token: string | null): boolean => {
  const expected = bindings.ACCESS_TOKEN;
  if (!token || !expected) {
    return false;
  }
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const controller = new InboxController({
  emailDatabase: new EmailDatabase(bindings.DB),
  emailParser: new EmailParser(),
  fileSystem: new R2FileSystem(bindings.EMAILS),
});
const app = createApp(
  controller,
  (app) => {
    app.set('view', BundledView);
    app.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      if (
        req.path !== '/' &&
        req.path !== '/logout' &&
        bindings.PRIVATE_ACCESS !== 'false' &&
        !isTokenValid(getToken(req))
      ) {
        controller.render403Response(req, res);
        return;
      }
      next();
    });
  },
  [
    body('token')
      .isString()
      .custom((token: string) => {
        if (!isTokenValid(token)) {
          throw new Error('Provided token is invalid!');
        }
        return true;
      }),
    buildRememberBodyValidator(),
  ],
);
app.listen(3000);

const http = httpServerHandler({ port: 3000 });
export const worker = {
  fetch: http.fetch,
  email: (message: ForwardableEmailMessage, env: Env): Promise<void> => receiveEmail(message, env),
  scheduled: async (_event: unknown, env: Env): Promise<void> => {
    await new EmailDatabase(env.DB).deleteExpired();
  },
};

// Workers require a default export for their event handlers.
export default worker;
