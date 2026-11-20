// google-workspace-signin.ts — "Sign in as Curia" for Google Workspace from the console (#2683).
//
//   GET  /api/google-workspace/status   — console (assertSecret): the live sign-in check and the
//                                          callback URL to add to the OAuth client
//   POST /api/google-workspace/signin   — console (assertSecret): mint a state, answer Google's URL
//   GET  /api/google-workspace/callback — PUBLIC: Google redirects here; the single-use state is the
//                                          only credential. 302 to the console's done page
//
// The whole prefix is bearer-exempt (SELF_AUTHED_API_PREFIXES); the first two authenticate
// themselves, the callback authorizes by the state alone, as the mailbox sign-in callback does.
// The done page's query carries the outcome and the restart flag, never the state or the code.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import {
  WorkspaceCheckUnavailableError,
  WorkspaceSignInUnavailableError,
  type GoogleWorkspaceSignInService,
  type WorkspaceCallbackQuery,
  type WorkspaceCallbackResult,
} from '../../../google/workspace-signin.js';

export interface GoogleWorkspaceSignInRouteOptions {
  service: Pick<GoogleWorkspaceSignInService, 'status' | 'start' | 'handleCallback' | 'callbackUrl'>;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  /** The real pino logger. Fastify is created with `logger: false`, so request.log is a no-op. */
  logger: Logger;
}

function donePage(r: WorkspaceCallbackResult): string {
  const params = new URLSearchParams({ result: r.outcome, restart: r.restartScheduled ? '1' : '0' });
  return `/google-workspace/done?${params.toString()}`;
}

/** Only single-valued string params reach the handler; a repeated or odd one is dropped. */
function callbackQuery(raw: unknown): WorkspaceCallbackQuery {
  const q: WorkspaceCallbackQuery = {};
  if (typeof raw !== 'object' || raw === null) return q;
  const bag = raw as Record<string, unknown>;
  for (const key of ['state', 'code', 'error'] as const) {
    const v = bag[key];
    if (typeof v === 'string') q[key] = v;
  }
  return q;
}

export async function googleWorkspaceSignInRoutes(
  app: FastifyInstance,
  options: GoogleWorkspaceSignInRouteOptions,
): Promise<void> {
  const { service, webAppBootstrapSecret, sessions } = options;
  const log = options.logger.child({ component: 'google-workspace-signin' });
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  // The callback is unauthenticated, so cap abuse per IP. No-op without @fastify/rate-limit.
  const CALLBACK_RATE = { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } };

  app.get('/api/google-workspace/status', AUTH_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const callbackUrl = service.callbackUrl();
    try {
      return reply.send({ ...(await service.status()), callbackUrl });
    } catch (err) {
      if (!(err instanceof WorkspaceCheckUnavailableError)) {
        log.error({ errName: err instanceof Error ? err.name : typeof err }, 'GET /api/google-workspace/status failed');
      }
      return reply.send({
        state: 'unknown',
        detail: err instanceof WorkspaceCheckUnavailableError ? err.message : 'Could not check the sign-in right now. Try again in a moment.',
        callbackUrl,
      });
    }
  });

  app.post('/api/google-workspace/signin', AUTH_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const { url, expiresAt } = await service.start();
      return reply.send({ url, expiresAt: expiresAt.toISOString() });
    } catch (err) {
      if (err instanceof WorkspaceSignInUnavailableError) {
        return reply.status(409).send({ error: err.detail, reason: err.reason });
      }
      log.error({ errName: err instanceof Error ? err.name : typeof err }, 'POST /api/google-workspace/signin failed');
      return reply.status(500).send({ error: 'Could not start the sign-in. Check the server logs.' });
    }
  });

  // Google sends the browser back here. handleCallback throws only on a database or vault read;
  // the catch makes sure the visitor still lands on the done page, never a 500.
  app.get('/api/google-workspace/callback', CALLBACK_RATE, async (request, reply) => {
    try {
      return reply.redirect(donePage(await service.handleCallback(callbackQuery(request.query))));
    } catch (err) {
      // Name only: never the query, which holds the state and the code.
      log.error({ errName: err instanceof Error ? err.name : typeof err }, 'GET /api/google-workspace/callback failed');
      return reply.redirect(donePage({ outcome: 'failed', restartScheduled: false }));
    }
  });
}
