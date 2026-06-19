import Fastify from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '../../../../src/logger.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeGraphRoutes } from '../../../../src/channels/http/routes/kg.js';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

// Minimal ContactService stub. The canonical-field validation in
// POST /api/kg/contacts runs before any service call, so for the email-format
// tests below createContact must never be reached.
function createContactService(): ContactService {
  return {
    createContact: vi.fn(),
    getContact: vi.fn(),
    setTrustLevel: vi.fn(),
    setTier: vi.fn(),
    setKind: vi.fn(),
    saveContact: vi.fn(),
    updateDisplayName: vi.fn(),
    setRole: vi.fn(),
    setStatus: vi.fn(),
    updateContactFields: vi.fn(),
    validatePrimaryEmail: vi.fn(),
  } as unknown as ContactService;
}

// Creates a pool mock that also supports pool.connect() for transaction tests.
function createTransactionalPool(client: Partial<PoolClient>): Pick<Pool, 'query' | 'connect'> {
  return {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pick<Pool, 'query' | 'connect'>;
}

// A minimal valid Contact shape returned by contactService.getContact() stubs.
function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    displayName: 'Test User',
    role: null,
    status: 'confirmed',
    trustLevel: null,
    tier: 'known',
    kind: 'person',
    systemRole: null,
    kgNodeId: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    contactConfidence: 0,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    ...overrides,
  };
}

describe('knowledgeGraphRoutes', () => {
  const pool = {
    query: vi.fn(),
  } as unknown as Pick<Pool, 'query'>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects API requests without x-web-bootstrap-secret', async () => {
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/kg/nodes' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('returns node results when authenticated', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          type: 'person',
          label: 'Ada Lovelace',
          properties: { role: 'founder' },
          confidence: 0.9,
          decay_class: 'slow_decay',
          source: 'seed',
          created_at: '2026-01-01T00:00:00.000Z',
          last_confirmed_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/kg/nodes?query=ada',
      headers: { 'x-web-bootstrap-secret': 'secret-1' },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0].label).toBe('Ada Lovelace');

    await app.close();
  });

  it('returns 404 at / (console app handles that route, not kg.ts)', async () => {
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
    });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('returns 400 for a malformed node_id UUID', async () => {
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/kg/graph?node_id=not-a-uuid',
      headers: { 'x-web-bootstrap-secret': 'secret-1' },
    });

    // Should be rejected before touching the DB — pool.query must not be called.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid node_id/);
    expect(pool.query).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns 503 when the secret is not configured', async () => {
    // This exercises the defensive assertSecret path. In normal operation the
    // http-adapter does not register the routes when the secret is absent, but
    // the guard is kept inside the route handler as a belt-and-suspenders check.
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: undefined,
      secureCookies: false,
      sessions: new Map(),
    });

    const response = await app.inject({ method: 'GET', url: '/api/kg/nodes' });
    expect(response.statusCode).toBe(503);

    await app.close();
  });

  // Regression for CodeQL #96 (js/polynomial-redos). The primaryEmail format
  // regex must not exhibit super-linear backtracking on attacker-controlled
  // input. A pathological value of length ~100k once forced the vulnerable
  // pattern into seconds of quadratic backtracking; the fixed pattern rejects
  // it in well under a millisecond. The route must reject it (400) before
  // touching the contact service, and do so quickly.
  it('rejects a ReDoS-crafted primaryEmail quickly, before any service call', async () => {
    const contactService = createContactService();
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
      contactService,
    });

    // Trailing '@' makes the address invalid, forcing the matcher to explore
    // every partition of the repeated 'a.' run — worst case for the old regex.
    const evilEmail = `a@${'a.'.repeat(50_000)}a@`;

    const start = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/contacts',
      headers: { 'x-web-bootstrap-secret': 'secret-1' },
      payload: { displayName: 'Test Contact', primaryEmail: evilEmail },
    });
    const elapsedMs = performance.now() - start;

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid primaryEmail/);
    expect(contactService.createContact).not.toHaveBeenCalled();
    // The vulnerable regex takes multiple seconds on this input; the fix is sub-ms.
    expect(elapsedMs).toBeLessThan(1000);

    await app.close();
  }, 20_000);

  it('accepts a well-formed primaryEmail through to the contact service', async () => {
    const contactService = createContactService();
    const app = Fastify();
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
      contactService,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/kg/contacts',
      headers: { 'x-web-bootstrap-secret': 'secret-1' },
      payload: { displayName: 'Test Contact', primaryEmail: 'first.last@sub.example.co.uk' },
    });

    // A valid address passes format validation and reaches createContact.
    // (The stub's createContact resolves undefined, so the handler throws on
    // `created.id` and Fastify returns 500 — that's fine; we only assert the
    // email cleared format validation and reached the service call.)
    expect(contactService.createContact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(contactService.createContact).mock.calls[0]![0]).toMatchObject({
      primaryEmail: 'first.last@sub.example.co.uk',
    });
    expect(response.statusCode).not.toBe(400);

    await app.close();
  });

  // Regression for CodeQL #98 (js/missing-rate-limiting). GET /api/kg/chat/history
  // reads from the working_memory table and was the only KG route missing the
  // KG_RATE (60/min) per-route override — leaving it covered only by the looser
  // global limit. We register @fastify/rate-limit with a deliberately high global
  // cap (1000) so the route's own 60/min ceiling is the ONLY thing that can trip a
  // 429: without the override all 61 requests would pass the limiter and return
  // 401 at the secret guard; with it, the 61st is rejected by the limiter first.
  it('rate-limits GET /api/kg/chat/history with the KG per-route cap', async () => {
    const app = Fastify();
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
    await app.register(knowledgeGraphRoutes, {
      pool,
      logger: createLogger(),
      webAppBootstrapSecret: 'secret-1',
      secureCookies: false,
      sessions: new Map(),
    });

    // The rate-limit onRequest hook runs before the handler's assertSecret check,
    // so it increments on every (unauthenticated) request. Fire a handful past the
    // 60/min cap rather than pinning the assertion to the exact 61st request — the
    // boundary index isn't what we're testing, only that the per-route cap engages.
    const url = '/api/kg/chat/history?conversationId=c1';
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      const res: LightMyRequestResponse = await app.inject({ method: 'GET', url });
      statuses.push(res.statusCode);
    }

    // The first request passes the limiter and is rejected by the secret guard —
    // proves requests reach past the rate limiter, so a later 429 comes from the
    // limiter and not some blanket rejection.
    expect(statuses[0]).toBe(401);
    // A 429 within 65 requests can only come from the route's own 60/min override:
    // the global cap is 1000, so without KG_RATE none of these would be throttled.
    expect(statuses).toContain(429);

    await app.close();
  });

  // ── Tier / kind validation (issue #1055) ────────────────────────────────────

  describe('PATCH /api/kg/contacts/:id — tier/kind validation', () => {
    it('rejects an invalid tier value with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(makeContact() as never);

      const client: Partial<PoolClient> = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { tier: 'superuser' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid tier/);
      await app.close();
    });

    it('rejects tier="principal" (structural guard) with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(makeContact() as never);

      const client: Partial<PoolClient> = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { tier: 'principal' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid tier/);
      await app.close();
    });

    it('rejects kind="principal" (structural guard) with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(makeContact() as never);

      const client: Partial<PoolClient> = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { kind: 'principal' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid kind/);
      await app.close();
    });

    it('rejects kind="agent" (structural guard) with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(makeContact() as never);

      const client: Partial<PoolClient> = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { kind: 'agent' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid kind/);
      await app.close();
    });

    it('rejects tier changes on the principal contact with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(
        makeContact({ systemRole: 'principal', tier: 'principal', kind: 'principal' }) as never,
      );

      const client: Partial<PoolClient> = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { tier: 'known' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/principal/i);
      await app.close();
    });

    it('rolls back the transaction and returns 500 when a mutation fails mid-PATCH', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(makeContact() as never);
      // saveContact throws to simulate a DB failure inside the transaction.
      vi.mocked(contactService.saveContact).mockRejectedValue(new Error('DB error'));

      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      const clientRelease = vi.fn();
      const client: Partial<PoolClient> = { query: clientQuery, release: clientRelease };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { displayName: 'New Name', tier: 'trusted' },
      });

      expect(res.statusCode).toBe(500);
      // ROLLBACK must have been called after the failure.
      const rollbackCall = vi.mocked(clientQuery).mock.calls.find(
        args => args[0] === 'ROLLBACK',
      );
      expect(rollbackCall).toBeDefined();
      // The client must always be released (finally block).
      expect(clientRelease).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it('accepts valid tier and kind values and writes them via saveContact', async () => {
      const contactService = createContactService();
      const contact = makeContact();
      vi.mocked(contactService.getContact).mockResolvedValue(contact as never);
      vi.mocked(contactService.saveContact).mockResolvedValue(contact as never);

      const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
      const client: Partial<PoolClient> = { query: clientQuery, release: vi.fn() };
      const txPool = createTransactionalPool(client);

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: txPool as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { tier: 'trusted', kind: 'organization' },
      });

      // saveContact must have been called with a contact snapshot that has the updated
      // tier and kind merged in, and with the transaction client.
      expect(contactService.saveContact).toHaveBeenCalledTimes(1);
      const [savedContact, savedClient] = (contactService.saveContact as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(savedContact.tier).toBe('trusted');
      expect(savedContact.kind).toBe('organization');
      expect(savedClient).toBe(client);
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('rejects kind changes for agent contacts with 400', async () => {
      const contactService = createContactService();
      vi.mocked(contactService.getContact).mockResolvedValue(
        makeContact({ systemRole: 'agent', kind: 'agent' }) as never,
      );

      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool: { query: vi.fn() } as unknown as Pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/kg/contacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { kind: 'person' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/system contact/i);
      await app.close();
    });
  });

  describe('POST /api/kg/contacts — tier/kind validation', () => {
    it('rejects an invalid tier value with 400', async () => {
      const contactService = createContactService();
      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kg/contacts',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { displayName: 'Test', tier: 'superuser' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Invalid tier/);
      expect(contactService.createContact).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects tier="principal" in POST (structural guard)', async () => {
      const contactService = createContactService();
      const app = Fastify();
      await app.register(knowledgeGraphRoutes, {
        pool,
        logger: createLogger(),
        webAppBootstrapSecret: 'secret-1',
        secureCookies: false,
        sessions: new Map(),
        contactService,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kg/contacts',
        headers: { 'x-web-bootstrap-secret': 'secret-1' },
        payload: { displayName: 'Test', tier: 'principal' },
      });

      expect(res.statusCode).toBe(400);
      expect(contactService.createContact).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
