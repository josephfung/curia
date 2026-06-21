// email-accounts.ts — HTTP CRUD routes for the email accounts management console.
//
// Routes live under /api/registry/email-accounts, which the existing auth bypass
// in http-adapter.ts (routeUrl.startsWith('/api/registry')) already covers, so
// these routes never reach the Bearer-token gate.
//
// Auth on every handler: session-cookie or x-web-bootstrap-secret (via assertSecret),
// same pattern as channel-registry.ts / vault.ts.
//
//   GET    /api/registry/email-accounts        — list all accounts with hasGrant status
//   POST   /api/registry/email-accounts        — create account row + write grant to vault
//   PATCH  /api/registry/email-accounts/:name  — update selfEmail/enabled; re-write grant
//   DELETE /api/registry/email-accounts/:name  — remove row + delete grant key

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { SessionStore } from '../session-auth.js';
import { assertSecret } from '../session-auth.js';
import { EmailAccountsRepo } from '../../email/email-accounts-repo.js';
import {
  emailAccountGrantSecretName,
  isValidEmailAccountName,
  EMAIL_ACCOUNT_NAME_RE,
} from '../../email/email-account-secrets.js';

// The actor label written to created_by — no per-user identity in the console today.
const ACTOR = 'web-console';

// Narrow interface for the secrets service so the route module can be tested with a
// fake without depending on the full SecretsService class. The real SecretsService
// exposes get / set / delete — verified in secrets-service.ts line 24 / 53 / 73.
export interface SecretsPort {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface EmailAccountsRouteOptions {
  pool: Pool;
  secretsService: SecretsPort;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  /**
   * Optional repo injection for unit tests. When provided, the route module skips
   * constructing `new EmailAccountsRepo(pool)` and uses this instance directly,
   * letting tests pass a fake without a real Postgres connection.
   *
   * Production callers never set this; `pool` is used instead.
   */
  repoForTest?: EmailAccountsRepo;
}

export async function emailAccountsRoutes(
  app: FastifyInstance,
  options: EmailAccountsRouteOptions,
): Promise<void> {
  const { secretsService, webAppBootstrapSecret, sessions } = options;
  // Use the injected test repo if provided; otherwise construct from the real pool.
  const repo = options.repoForTest ?? new EmailAccountsRepo(options.pool);

  // Auth helper — validates session cookie or bootstrap secret on every request.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // Stricter per-route rate limit: 30 req/min per IP — mirrors channel-registry.ts.
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  // -- GET /api/registry/email-accounts — list all accounts with hasGrant status --

  app.get('/api/registry/email-accounts', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const rows = await repo.list();
      const accounts = await Promise.all(rows.map(async r => ({
        name: r.name,
        selfEmail: r.selfEmail,
        provider: r.provider,
        enabled: r.enabled,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
        updatedAt: r.updatedAt,
        // Status only — never the grant value. `!== null` converts null/string → boolean.
        hasGrant: (await secretsService.get(emailAccountGrantSecretName(r.name))) !== null,
      })));
      return reply.send({ accounts });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/email-accounts failed');
      return reply.status(500).send({ error: 'Failed to list email accounts. Check server logs.' });
    }
  });

  // -- POST /api/registry/email-accounts — create account row + write grant to vault --

  app.post('/api/registry/email-accounts', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as {
      name?: unknown;
      selfEmail?: unknown;
      provider?: unknown;
      grantId?: unknown;
    };

    // Extract and validate all inputs before any write.
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const selfEmail = typeof body.selfEmail === 'string' ? body.selfEmail.trim() : '';
    const grantId = typeof body.grantId === 'string' ? body.grantId.trim() : '';
    // Default provider to 'nylas' when omitted; reject any other explicit value.
    const provider = typeof body.provider === 'string' && body.provider.trim()
      ? body.provider.trim()
      : 'nylas';

    if (!isValidEmailAccountName(name)) {
      return reply.status(400).send({ error: `name must match ${EMAIL_ACCOUNT_NAME_RE.source}` });
    }
    if (!selfEmail) {
      return reply.status(400).send({ error: 'selfEmail is required' });
    }
    if (!grantId) {
      return reply.status(400).send({ error: 'grantId is required' });
    }
    if (provider !== 'nylas') {
      return reply.status(400).send({ error: `unsupported provider '${provider}' — only 'nylas' is supported` });
    }

    // Fast-path duplicate check for a clean 409 in the common (non-concurrent) case.
    // The INSERT's PRIMARY KEY is the real guard for the concurrent race (handled below).
    if (await repo.get(name)) {
      return reply.status(409).send({ error: `email account '${name}' already exists` });
    }

    try {
      // Create the row FIRST so the PRIMARY KEY decides the winner atomically. Under two
      // concurrent POSTs for the same name, the loser's INSERT throws 23505 *before* it
      // writes any grant, so it can never overwrite the winner's grant (the prior
      // grant-first ordering had exactly that race). Then write the grant; if that fails,
      // compensate by deleting the row so we never leave an account without its grant.
      const row = await repo.create({ name, selfEmail, provider, createdBy: ACTOR });
      try {
        await secretsService.set(emailAccountGrantSecretName(name), grantId);
      } catch (err) {
        await repo.delete(name).catch(() => {});
        throw err;
      }
      request.log.info({ account: name }, 'email account created');
      // hasGrant: true — we just wrote it; status only, never the value.
      return reply.status(201).send({ account: { ...row, hasGrant: true } });
    } catch (err) {
      // Postgres unique_violation: a concurrent request won the create race. Report the
      // accurate 409 rather than a misleading 500.
      if (err instanceof Error && (err as { code?: string }).code === '23505') {
        return reply.status(409).send({ error: `email account '${name}' already exists` });
      }
      request.log.error({ err, name }, 'POST /api/registry/email-accounts failed');
      return reply.status(500).send({ error: 'Failed to create email account. Check server logs.' });
    }
  });

  // -- PATCH /api/registry/email-accounts/:name — update row; optionally re-write grant --

  app.patch('/api/registry/email-accounts/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };

    // Belt-and-suspenders: the DB row is the primary gate (only a name that passed
    // POST validation can exist in the table), but we validate directly here so that
    // vault-key construction never depends on an invariant enforced elsewhere.
    if (!isValidEmailAccountName(name)) {
      return reply.status(400).send({ error: `name must match ${EMAIL_ACCOUNT_NAME_RE.source}` });
    }

    const body = (request.body ?? {}) as {
      selfEmail?: unknown;
      enabled?: unknown;
      grantId?: unknown;
    };

    // Confirm the account exists before applying any update.
    if (!(await repo.get(name))) {
      return reply.status(404).send({ error: `email account '${name}' not found` });
    }

    try {
      // Re-write the vault grant when a new grantId is provided. The field is optional
      // so callers can update selfEmail/enabled without re-supplying the grant.
      if (typeof body.grantId === 'string' && body.grantId.trim()) {
        await secretsService.set(emailAccountGrantSecretName(name), body.grantId.trim());
      }

      // Build the DB patch — only include fields that were explicitly provided.
      const patch: { selfEmail?: string; enabled?: boolean } = {};
      if (typeof body.selfEmail === 'string' && body.selfEmail.trim()) {
        patch.selfEmail = body.selfEmail.trim();
      }
      if (typeof body.enabled === 'boolean') {
        patch.enabled = body.enabled;
      }

      const row = await repo.update(name, patch);
      if (!row) {
        // Should not happen (we checked above), but guard the null so TS doesn't complain.
        return reply.status(404).send({ error: `email account '${name}' not found` });
      }
      request.log.info({ account: name }, 'email account updated');
      return reply.send({ account: row });
    } catch (err) {
      request.log.error({ err, name }, 'PATCH /api/registry/email-accounts/:name failed');
      return reply.status(500).send({ error: 'Failed to update email account. Check server logs.' });
    }
  });

  // -- DELETE /api/registry/email-accounts/:name — remove row + delete grant key --

  app.delete('/api/registry/email-accounts/:name', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };

    // Belt-and-suspenders: the DB row is the primary gate, but we validate directly
    // here so vault-key construction never depends on an invariant enforced elsewhere.
    if (!isValidEmailAccountName(name)) {
      return reply.status(400).send({ error: `name must match ${EMAIL_ACCOUNT_NAME_RE.source}` });
    }

    let deleted: boolean;
    try {
      deleted = await repo.delete(name);
    } catch (err) {
      request.log.error({ err, name }, 'DELETE /api/registry/email-accounts/:name failed');
      return reply.status(500).send({ error: 'Failed to delete email account. Check server logs.' });
    }

    if (!deleted) {
      return reply.status(404).send({ error: `email account '${name}' not found` });
    }

    // Best-effort: remove the grant key from the vault now that the row is gone.
    // If this fails, the orphaned vault entry is inert — there is no DB row for the
    // channel to look up, so the key can never be used. Log the error and continue
    // rather than returning 500 (which would be confusing: the row IS deleted, and
    // a retry by the caller would get 404).
    try {
      await secretsService.delete(emailAccountGrantSecretName(name));
    } catch (err) {
      request.log.error({ err, name }, 'email account deleted but vault grant key removal failed — orphaned key is inert without a DB row');
    }

    request.log.info({ account: name }, 'email account deleted');
    return reply.send({ ok: true });
  });
}
