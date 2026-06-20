// kg.test.ts — exercises the contact POST and PATCH routes against a fake
// ContactService. Auth uses the x-web-bootstrap-secret header path (same path
// as the route uses). Pool, Bus, EventRouter are stubbed — the contact endpoints
// do not touch them.
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { knowledgeGraphRoutes } from './kg.js';
import type { ContactService } from '../../../contacts/contact-service.js';
import type { Contact } from '../../../contacts/types.js';
import type { EventBus } from '../../../bus/bus.js';
import type { EventRouter } from '../event-router.js';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';

const BOOTSTRAP = 'test-bootstrap-secret';

// Minimal contact fixture satisfying the Contact interface.
const BASE_CONTACT: Contact = {
  id: '11111111-1111-1111-1111-111111111111',
  kgNodeId: null,
  displayName: 'Alice',
  role: null,
  systemRole: null,
  tier: 'known',
  kind: 'person',
  contactConfidence: 0,
  lastSeenAt: null,
  inboundMessageCount: 0,
  outboundMessageCount: 0,
  notes: null,
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
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

// Build a fake ContactService — only the methods the contact routes call are
// implemented; everything else stays undefined.
function fakeContactService(overrides: Partial<ContactService> = {}): ContactService {
  const base: Partial<ContactService> = {
    createContact: vi.fn().mockResolvedValue(BASE_CONTACT),
    getContact: vi.fn().mockResolvedValue(BASE_CONTACT),
    saveContact: vi.fn().mockResolvedValue(BASE_CONTACT),
    // Only the methods actually called by the contact routes are implemented here.
    // Any call to an unimplemented method will throw (undefined is not a function),
    // which causes the test to fail loudly — intentional.
    validatePrimaryEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return base as ContactService;
}

// Stub out dependencies the contact endpoints don't use for contact CRUD.
// The PATCH route calls pool.connect() to wrap saveContact in a transaction,
// so we need a minimal pool stub that returns a fake client.
function makeFakePool(): Pool {
  const fakeClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(fakeClient),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  return pool as unknown as Pool;
}

const stubBus = {} as EventBus;
const stubEventRouter = {} as EventRouter;
const stubLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

async function build(service: ContactService): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(knowledgeGraphRoutes, {
    pool: makeFakePool(),
    logger: stubLogger,
    webAppBootstrapSecret: BOOTSTRAP,
    secureCookies: false,
    bus: stubBus,
    eventRouter: stubEventRouter,
    contactService: service,
    sessions: new Map(),
  });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

describe('POST /api/kg/contacts — status field removal', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('creates a contact without a status field and returns 201', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/kg/contacts',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contact.id).toBe(BASE_CONTACT.id);
  });

  it('ignores a legacy status field in POST and returns 201', async () => {
    // The route no longer reads body.status, so any value is silently ignored.
    // Fastify does not schema-validate bodies without an explicit JSON schema,
    // so unknown fields pass through — the response should be 201.
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/kg/contacts',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice', status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a POST with no displayName with 400', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/kg/contacts',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/kg/contacts/:id — status field removal', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('patches a contact without a status field and returns 200', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/kg/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice Updated' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('ignores a legacy status field in PATCH and returns 200', async () => {
    // Decision: IGNORE (200), not reject (400).
    // Justification: kg.ts does not attach a JSON schema to routes, so Fastify
    // passes through all body fields without validation. Unknown fields are simply
    // not read. A legacy status field in the body is silently ignored — no 400,
    // and the route still saves the contact normally.
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/kg/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the contact does not exist', async () => {
    const svc = fakeContactService({ getContact: vi.fn().mockResolvedValue(undefined) });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/kg/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(res.statusCode).toBe(404);
  });
});
