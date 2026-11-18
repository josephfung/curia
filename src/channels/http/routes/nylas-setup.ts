// nylas-setup.ts — console routes that set up Nylas mailbox sign-in from the API key (#2361).
//
// Under /api/registry/nylas, covered by the /api/registry auth bypass in http-adapter.ts; every
// handler authenticates itself via assertSecret (session cookie or bootstrap secret).
//
//   GET  /signin            — readiness + the callback URL and Google redirect URI to paste
//   PUT  /region            — { region: 'us' | 'eu' } -> saved as channel.email.nylas_region
//   POST /discover-region   — probe both regions with the saved key, save the match
//   POST /callback          — register the sign-in callback URL with Nylas
//   POST /google-connector  — { client_id, client_secret, topic_name? } -> create the Google connector
//   POST /signin-links      — { target, label?, address? } -> a single-use sign-in link for the console button
//
// The Nylas API key and the GCP client secret never leave this module: the GCP secret is passed
// to Nylas and then dropped (Curia stores and echoes nothing), errors are logged by class and
// status only, and the audit rows carry key names and the action, never a value.
//
// Each change is audited in two stages as secret.changed (a `nylas_*` action), like the vault
// routes: `requested` before the change (refused if it cannot be written), `completed` after.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { EventBus } from '../../../bus/bus.js';
import { createSecretChanged } from '../../../bus/events.js';
import { assertSecret, type SessionStore } from '../session-auth.js';
import { actorFromRequest } from './sessions.js';
import { NylasAppClient, NylasAppError } from '../../../nylas/app-client.js';
import { nylasApiUri, parseNylasRegion, type NylasRegion } from '../../../nylas/region.js';
import {
  MAILBOX_SIGNIN_SCOPES,
  NYLAS_API_KEY_SECRET,
  NYLAS_REGION_SECRET,
  checkNylasSignIn,
  createNylasSignInReaders,
  mailboxSignInCallbackUrl,
  type NylasBootConfig,
} from '../../../nylas/signin-readiness.js';
import {
  MailboxSignInAddressError,
  MailboxSignInUnavailableError,
  type MailboxSignInService,
} from '../../../nylas/mailbox-signin-service.js';
import { grantSafeErrorFields } from '../../../principal-mailboxes/error-fields.js';

export interface NylasSetupRouteOptions {
  secretsService: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
  };
  appOrigin: string | undefined;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  bus: Pick<EventBus, 'publish'>;
  logger: Logger;
  /** The boot-time Nylas key and region: readiness reads restart_required after either changes. */
  boot?: NylasBootConfig;
  /** Mints the console's "Connect with Google" links. Absent: the route answers 409. */
  signIn?: Pick<MailboxSignInService, 'mint' | 'mintForOperator'>;
  /** Test seams. */
  makeClient?: (apiKey: string, apiUri: string) => NylasAppClient;
  probeRegion?: (apiKey: string) => Promise<NylasRegion | null>;
  env?: NodeJS.ProcessEnv;
}

type NylasAction = 'nylas_region' | 'nylas_callback' | 'nylas_connector';

// A Google OAuth client secret / id are short; the cap is defense in depth on top of bodyLimit.
const MAX_FIELD = 512;
const MAX_LINK_LABEL = 80;

/** Nylas's Google redirect URI for a region, to paste into the GCP OAuth client. */
function googleRedirectUri(region: NylasRegion): string {
  return `${nylasApiUri(region)}/v3/connect/callback`;
}

export async function nylasSetupRoutes(app: FastifyInstance, options: NylasSetupRouteOptions): Promise<void> {
  const { secretsService, webAppBootstrapSecret, sessions, logger, bus } = options;
  const env = options.env ?? process.env;
  const readers = createNylasSignInReaders({ secrets: secretsService, env, logger });
  const makeClient = options.makeClient
    ?? ((apiKey: string, apiUri: string) => new NylasAppClient({ apiKey, apiUri, logger }));
  const probeRegion = options.probeRegion ?? ((apiKey: string) => NylasAppClient.probeRegion(apiKey));

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  function payload(request: FastifyRequest, secretName: string, action: NylasAction, stage: 'requested' | 'completed') {
    return createSecretChanged({ secretName, action, stage, ...actorFromRequest(request, sessions) });
  }

  // Sends the 500 itself and returns false when the audit row could not be written.
  async function auditRequested(request: FastifyRequest, reply: FastifyReply, secretName: string, action: NylasAction): Promise<boolean> {
    try {
      await bus.publish('system', payload(request, secretName, action, 'requested'));
      return true;
    } catch (err) {
      request.log.error({ ...grantSafeErrorFields(err), action }, 'nylas setup audit write failed — change refused');
      void reply.status(500).send({ error: 'Nothing was changed: the change could not be audited, so it was not made. Check the server logs.' });
      return false;
    }
  }

  async function auditCompleted(request: FastifyRequest, secretName: string, action: NylasAction): Promise<void> {
    try {
      await bus.publish('system', payload(request, secretName, action, 'completed'));
    } catch (err) {
      request.log.error({ ...grantSafeErrorFields(err), action }, 'nylas setup outcome audit write failed');
    }
  }

  /** What to tell the operator when a Nylas call failed, by status only. */
  function nylasFailureMessage(err: unknown): string {
    const status = err instanceof NylasAppError ? err.status : 0;
    if (status === 401 || status === 403) return 'Nylas rejected the API key. Check the key and the region.';
    if (status === 0 || status >= 500) return 'Nylas did not answer; try again in a moment.';
    return 'Nylas refused the request. Check the values and try again.';
  }

  // The key must be saved; sends the 409 itself and returns undefined when it is not.
  async function requireKey(reply: FastifyReply): Promise<string | undefined> {
    const key = await readers.readApiKey();
    if (key === undefined) {
      void reply.status(409).send({ error: 'Save the Nylas API key first (Channels → Email).' });
      return undefined;
    }
    return key;
  }

  async function saveRegion(request: FastifyRequest, reply: FastifyReply, region: NylasRegion): Promise<boolean> {
    if (!await auditRequested(request, reply, NYLAS_REGION_SECRET, 'nylas_region')) return false;
    try {
      await secretsService.set(NYLAS_REGION_SECRET, region);
    } catch (err) {
      request.log.error(grantSafeErrorFields(err), 'nylas region save failed');
      void reply.status(500).send({ error: 'Failed to save the region. Check server logs.' });
      return false;
    }
    await auditCompleted(request, NYLAS_REGION_SECRET, 'nylas_region');
    return true;
  }

  app.get('/api/registry/nylas/signin', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const readiness = await checkNylasSignIn({
        ...readers, appOrigin: options.appOrigin, logger,
        // Readiness's own default client has the short timeout; only a test seam replaces it.
        ...(options.makeClient ? { makeClient: options.makeClient } : {}),
        ...(options.boot ? { boot: options.boot } : {}),
      });
      const region = await readers.readRegion();
      return reply.send({
        ...readiness,
        region,
        callbackUrl: options.appOrigin ? mailboxSignInCallbackUrl(options.appOrigin) : null,
        googleRedirectUri: googleRedirectUri(region),
      });
    } catch (err) {
      request.log.error(grantSafeErrorFields(err), 'GET /api/registry/nylas/signin failed');
      return reply.status(500).send({ error: 'Failed to check sign-in readiness. Check server logs.' });
    }
  });

  app.put('/api/registry/nylas/region', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const raw = (request.body as { region?: unknown } | undefined)?.region;
    const region = typeof raw === 'string' && raw.trim() !== '' ? parseNylasRegion(raw) : null;
    if (region === null) return reply.status(400).send({ error: "region must be 'us' or 'eu'" });
    if (!await saveRegion(request, reply, region)) return;
    return reply.send({ region });
  });

  app.post('/api/registry/nylas/discover-region', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const key = await requireKey(reply);
    if (key === undefined) return;
    let region: NylasRegion | null;
    try {
      region = await probeRegion(key);
    } catch (err) {
      request.log.error(grantSafeErrorFields(err), 'nylas region probe failed');
      return reply.status(502).send({ error: 'Nylas did not answer; try again in a moment.' });
    }
    if (region === null) {
      return reply.status(422).send({ error: 'Neither Nylas region accepted the API key. Check the key.' });
    }
    if (!await saveRegion(request, reply, region)) return;
    return reply.send({ region });
  });

  app.post('/api/registry/nylas/callback', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const key = await requireKey(reply);
    if (key === undefined) return;
    if (!options.appOrigin?.startsWith('https://')) {
      return reply.status(409).send({ error: "Sign-in needs APP_ORIGIN set to this console's public https:// address." });
    }
    const callbackUrl = mailboxSignInCallbackUrl(options.appOrigin);
    if (!await auditRequested(request, reply, NYLAS_API_KEY_SECRET, 'nylas_callback')) return;
    try {
      await makeClient(key, nylasApiUri(await readers.readRegion())).addCallbackUri(callbackUrl);
    } catch (err) {
      request.log.warn(grantSafeErrorFields(err), 'nylas callback registration failed');
      return reply.status(502).send({ error: nylasFailureMessage(err) });
    }
    await auditCompleted(request, NYLAS_API_KEY_SECRET, 'nylas_callback');
    return reply.send({ ok: true, callbackUrl });
  });

  app.post('/api/registry/nylas/google-connector', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { client_id?: unknown; client_secret?: unknown; topic_name?: unknown };
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
    const clientSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : '';
    const topicName = typeof body.topic_name === 'string' ? body.topic_name.trim() : '';
    if (clientId === '' || clientSecret === '') {
      return reply.status(400).send({ error: 'client_id and client_secret are required' });
    }
    if (clientId.length > MAX_FIELD || clientSecret.length > MAX_FIELD || topicName.length > MAX_FIELD) {
      return reply.status(400).send({ error: 'A value is too long' });
    }
    const key = await requireKey(reply);
    if (key === undefined) return;
    if (!await auditRequested(request, reply, NYLAS_API_KEY_SECRET, 'nylas_connector')) return;
    try {
      await makeClient(key, nylasApiUri(await readers.readRegion())).createGoogleConnector({
        clientId,
        clientSecret,
        ...(topicName !== '' ? { topicName } : {}),
        scopes: [...MAILBOX_SIGNIN_SCOPES],
      });
    } catch (err) {
      // Class and status only: the error text is never logged or returned.
      request.log.warn(grantSafeErrorFields(err), 'nylas google connector creation failed');
      return reply.status(502).send({ error: nylasFailureMessage(err) });
    }
    await auditCompleted(request, NYLAS_API_KEY_SECRET, 'nylas_connector');
    return reply.send({ ok: true });
  });

  // Operator-minted sign-in link. A principal link defaults to the principal's designated primary
  // address (the service resolves it); the operator, who is trusted, may name any other address.
  // A Curia link may be pinned to an address too (the callback then enforces it, R8); unpinned, it
  // lives 15 minutes. The link's token is only ever in the response body.
  app.post('/api/registry/nylas/signin-links', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { target?: unknown; label?: unknown; address?: unknown };
    if (body.target !== 'principal' && body.target !== 'curia') {
      return reply.status(400).send({ error: "target must be 'principal' or 'curia'" });
    }
    const target = body.target;
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (label.length > MAX_LINK_LABEL || address.length > MAX_FIELD) {
      return reply.status(400).send({ error: 'A value is too long' });
    }
    const signIn = options.signIn;
    if (signIn === undefined) {
      return reply.status(409).send({ error: 'Mailbox sign-in is not available on this server.' });
    }
    try {
      const link = target === 'principal' && address === ''
        ? await signIn.mint({ target, ...(label !== '' ? { label } : {}) })
        : await signIn.mintForOperator({
          target,
          ...(label !== '' ? { label } : {}),
          ...(address !== '' ? { expectedEmail: address } : {}),
        });
      return reply.send({ url: link.url, expiresAt: link.expiresAt.toISOString() });
    } catch (err) {
      if (err instanceof MailboxSignInUnavailableError) {
        request.log.warn({ reason: err.reason }, 'nylas sign-in link refused: sign-in not ready');
        return reply.status(409).send({ error: err.detail !== '' ? err.detail : `Mailbox sign-in is not ready (${err.reason}).` });
      }
      if (err instanceof MailboxSignInAddressError) {
        return reply.status(422).send({ error: err.message });
      }
      request.log.error(grantSafeErrorFields(err), 'nylas sign-in link mint failed');
      return reply.status(500).send({ error: 'Failed to create the sign-in link. Check server logs.' });
    }
  });
}
