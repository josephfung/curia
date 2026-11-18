// mailbox-signin.ts — public HTTP routes for signing in to a mailbox through Nylas hosted auth (#2361).
//
// UNAUTHENTICATED except for the token: the single-use token in the link IS the capability, as
// for secret capture. The routes sit outside the bearer-auth guard (see SELF_AUTHED_API_PREFIXES)
// and authorize by the token alone.
//
//   GET /api/mailbox-signin/start/:token — 302 to Nylas hosted auth, carrying the token as `state`
//
// The start route only PEEKS. The token is spent by the callback, so a link opened twice (a
// prefetch, a second tab) still works until the sign-in actually returns.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { NylasAppClient } from '../../../nylas/app-client.js';
import { nylasApiUri } from '../../../nylas/region.js';
import {
  MAILBOX_SIGNIN_SCOPES,
  mailboxSignInCallbackUrl,
  type NylasSignInReadiness,
} from '../../../nylas/signin-readiness.js';
import type { MailboxSignInService } from '../../../nylas/mailbox-signin-service.js';

export interface MailboxSignInRouteOptions {
  /** Only what the start route needs; the callback adds consume. */
  signIn: Pick<MailboxSignInService, 'peek'>;
  /** Live readiness; supplies the application id (client_id) and region. */
  readiness: () => Promise<NylasSignInReadiness>;
  /** Live read of the Nylas API key, to build the region-correct client. */
  readApiKey: () => Promise<string | undefined>;
  appOrigin: string | undefined;
  /** Test seam. The default builds a real client. */
  makeClient?: (apiKey: string, apiUri: string) => Pick<NylasAppClient, 'buildAuthUrl'>;
  /** The real pino logger. Fastify is created with `logger: false`, so request.log is a no-op. */
  logger: Logger;
}

/** Where the SPA's result page lives; the page itself arrives with the callback work. */
function donePage(result: string): string {
  return `/mailbox-signin/done?result=${result}`;
}

export async function mailboxSignInRoutes(
  app: FastifyInstance,
  options: MailboxSignInRouteOptions,
): Promise<void> {
  const { signIn, readiness, readApiKey, appOrigin, logger } = options;
  const makeClient = options.makeClient
    ?? ((apiKey: string, apiUri: string) => new NylasAppClient({ apiKey, apiUri, logger }));

  // The token is unauthenticated, so cap abuse per IP. No-op if @fastify/rate-limit isn't registered.
  const START_RATE = { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } };

  app.get('/api/mailbox-signin/start/:token', START_RATE, async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const row = await signIn.peek(token);
      if (typeof row === 'string') return reply.redirect(donePage(row));

      // Re-check at click time: the key or the Nylas application can change after the link was minted.
      const state = await readiness();
      const apiKey = await readApiKey();
      if (!state.ready || appOrigin === undefined || apiKey === undefined) {
        logger.warn({ reason: state.ready ? 'no_api_key' : state.reason }, 'mailbox sign-in start refused: sign-in not ready');
        return reply.redirect(donePage('failed'));
      }

      const client = makeClient(apiKey, nylasApiUri(state.region));
      const authUrl = client.buildAuthUrl({
        clientId: state.applicationId,
        redirectUri: mailboxSignInCallbackUrl(appOrigin),
        state: token,
        ...(row.expected_email !== null ? { loginHint: row.expected_email } : {}),
        scopes: [...MAILBOX_SIGNIN_SCOPES],
      });
      return reply.redirect(authUrl);
    } catch (err) {
      // Never log the token; the failure alone is enough to find the cause. The visitor is anonymous.
      logger.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, 'GET /api/mailbox-signin/start failed');
      return reply.redirect(donePage('failed'));
    }
  });
}
