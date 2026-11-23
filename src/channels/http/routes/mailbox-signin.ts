// mailbox-signin.ts — public HTTP routes for signing in to a mailbox through Nylas hosted auth (#2361).
//
// UNAUTHENTICATED except for the token: the single-use token in the link IS the capability, as
// for secret capture. The routes sit outside the bearer-auth guard (see SELF_AUTHED_API_PREFIXES)
// and authorize by the token alone.
//
//   GET /api/mailbox-signin/start/:token — 302 to Nylas hosted auth, carrying the token as `state`
//   GET /api/mailbox-signin/callback     — Nylas redirects back here; 302 to the console's done page
//
// The start route only PEEKS. The token is spent by the callback, so a link opened twice (a
// prefetch, a second tab) still works until the sign-in actually returns.
//
// The done page's query carries the outcome, the target and whether a restart is coming — never
// the state, the code, an address or a grant id.

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
import type {
  MailboxSignInCallbackQuery,
  MailboxSignInCallbackResult,
} from '../../../nylas/mailbox-signin-callback.js';

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
  /** GET /api/health's started_at for this process: sent to the done page with a restart (#2697). */
  processStartedAt?: string;
  /** The callback logic (handleMailboxSignInCallback with its deps bound). Absent: the callback
   *  redirects to `failed` without touching the token. */
  callback?: (query: MailboxSignInCallbackQuery) => Promise<MailboxSignInCallbackResult>;
}

/** Where the SPA's result page lives. */
function donePage(result: string): string {
  return `/mailbox-signin/done?result=${result}`;
}

/** The done page after a callback: outcome, target (when a link was claimed) and restart flag,
 *  plus, with a restart, this process's start (`since`), which the page waits to see change. */
function callbackDonePage(r: Pick<MailboxSignInCallbackResult, 'outcome' | 'target' | 'restartScheduled'>, processStartedAt?: string): string {
  const params = new URLSearchParams({ result: r.outcome });
  if (r.target !== undefined) params.set('target', r.target);
  params.set('restart', r.restartScheduled ? '1' : '0');
  if (r.restartScheduled && processStartedAt) params.set('since', processStartedAt);
  return `/mailbox-signin/done?${params.toString()}`;
}

const CALLBACK_PARAMS = ['state', 'code', 'error', 'error_description'] as const;

/** Only single-valued string params reach the handler; a repeated or odd one is dropped. */
function callbackQuery(raw: unknown): MailboxSignInCallbackQuery {
  const q: MailboxSignInCallbackQuery = {};
  if (typeof raw !== 'object' || raw === null) return q;
  const bag = raw as Record<string, unknown>;
  for (const key of CALLBACK_PARAMS) {
    const v = bag[key];
    if (typeof v === 'string') q[key] = v;
  }
  return q;
}

export async function mailboxSignInRoutes(
  app: FastifyInstance,
  options: MailboxSignInRouteOptions,
): Promise<void> {
  const { signIn, readiness, readApiKey, appOrigin, logger, callback, processStartedAt } = options;
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

  // Nylas sends the browser back here after Google. The handler never throws by contract; the
  // catch is the last guard so the visitor always lands on the done page, never a 500.
  app.get('/api/mailbox-signin/callback', START_RATE, async (request, reply) => {
    if (callback === undefined) {
      logger.warn('mailbox sign-in callback reached but not wired');
      return reply.redirect(callbackDonePage({ outcome: 'failed', restartScheduled: false }));
    }
    try {
      const result = await callback(callbackQuery(request.query));
      return reply.redirect(callbackDonePage(result, processStartedAt));
    } catch (err) {
      // Name only: never the query, which holds the state and the code.
      logger.error({ errName: err instanceof Error ? err.name : typeof err }, 'GET /api/mailbox-signin/callback failed');
      return reply.redirect(callbackDonePage({ outcome: 'failed', restartScheduled: false }));
    }
  });
}
