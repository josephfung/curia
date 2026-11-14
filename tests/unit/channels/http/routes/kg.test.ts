// kg.test.ts — contact CRUD (via contactRoutes) and node-merge routes (via
// knowledgeGraphRoutes). Auth uses the x-web-bootstrap-secret header path.
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { knowledgeGraphRoutes } from '../../../../../src/channels/http/routes/kg.js';
import { contactRoutes } from '../../../../../src/channels/http/routes/contacts.js';
import type { ContactService } from '../../../../../src/contacts/contact-service.js';
import type { ChannelIdentity, Contact } from '../../../../../src/contacts/types.js';
import type { Pool } from 'pg';
import type { Logger } from '../../../../../src/logger.js';
import type { NodeMergeApi } from '../../../../../src/kg-merge/service.js';
import type { EventBus } from '../../../../../src/bus/bus.js';
import {
  InvalidResolutionError,
  MergeBlockedError,
  NodeNotFoundError,
  StalePreviewError,
} from '../../../../../src/kg-merge/errors.js';

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
    notePrimaryEmailChanged: vi.fn(),
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

const stubLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

async function build(service: ContactService): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(contactRoutes, {
    pool: makeFakePool(),
    logger: stubLogger,
    webAppBootstrapSecret: BOOTSTRAP,
    contactService: service,
    sessions: new Map(),
  });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

describe('POST /api/contacts — status field removal', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('creates a contact without a status field and returns 201', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts',
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
      url: '/api/contacts',
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
      url: '/api/contacts',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/contacts/:id — status field removal', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('patches a contact without a status field and returns 200', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
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
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('notifies after a committed primaryEmail change on the principal only', async () => {
    const principal = { ...BASE_CONTACT, systemRole: 'principal' as const };
    const notePrimaryEmailChanged = vi.fn();
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(principal),
      notePrimaryEmailChanged,
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ primaryEmail: 'Local@Domain.ca' }),
    });
    expect(res.statusCode).toBe(200);
    expect(notePrimaryEmailChanged).toHaveBeenCalledTimes(1);
    expect(notePrimaryEmailChanged).toHaveBeenCalledWith(BASE_CONTACT.id);
  });

  it('does not notify when a non-principal primaryEmail changes', async () => {
    const notePrimaryEmailChanged = vi.fn();
    const svc = fakeContactService({ notePrimaryEmailChanged });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ primaryEmail: 'other@domain.com' }),
    });
    expect(res.statusCode).toBe(200);
    expect(notePrimaryEmailChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['pronouns', { pronouns: 'she/her' }],
    ['preferredName', { preferredName: 'Avy' }],
    ['title', { title: 'CEO' }],
    ['displayName', { displayName: 'The Principal' }],
  ])('notifies after a committed principal %s change, since the prompt profile shows it (#2226)', async (_name, body) => {
    const principal = { ...BASE_CONTACT, systemRole: 'principal' as const };
    const notePrimaryEmailChanged = vi.fn();
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(principal),
      notePrimaryEmailChanged,
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    expect(notePrimaryEmailChanged).toHaveBeenCalledTimes(1);
    expect(notePrimaryEmailChanged).toHaveBeenCalledWith(BASE_CONTACT.id);
  });

  it('does not notify for a non-principal contact whose pronouns change', async () => {
    const notePrimaryEmailChanged = vi.fn();
    const svc = fakeContactService({ notePrimaryEmailChanged });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ pronouns: 'he/him' }),
    });
    expect(res.statusCode).toBe(200);
    expect(notePrimaryEmailChanged).not.toHaveBeenCalled();
  });

  it('does not notify a principal PATCH that touches no prompt field', async () => {
    const principal = { ...BASE_CONTACT, systemRole: 'principal' as const };
    const notePrimaryEmailChanged = vi.fn();
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(principal),
      notePrimaryEmailChanged,
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      // organization, not timezone: a timezone edit now refreshes (inbox triage reads it).
      body: JSON.stringify({ organization: 'Acme' }),
    });
    expect(res.statusCode).toBe(200);
    expect(notePrimaryEmailChanged).not.toHaveBeenCalled();
  });

  it('returns 404 when the contact does not exist', async () => {
    const svc = fakeContactService({ getContact: vi.fn().mockResolvedValue(undefined) });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${BASE_CONTACT.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/contacts/:id/identities', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  // The identities route validates the id against a strict RFC-4122 UUID regex
  // (version + variant nibbles), so use a well-formed v4 UUID here.
  const CID = '11111111-1111-4111-8111-111111111111';

  // A channel identity fixture with Date fields, so we can assert ISO serialization.
  const IDENTITY: ChannelIdentity = {
    id: '22222222-2222-4222-8222-222222222222',
    contactId: CID,
    channel: 'email',
    channelIdentifier: 'alice@example.com',
    label: 'Work',
    verified: true,
    verifiedAt: new Date('2024-02-02T03:04:05Z'),
    status: 'active',
    source: 'email_participant',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
  };

  it('returns the contact’s identities with Date fields serialized to ISO strings', async () => {
    const svc = fakeContactService({
      getIdentitiesForContact: vi.fn().mockResolvedValue([IDENTITY]),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CID}/identities`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { identities: Array<Record<string, unknown>> };
    expect(body.identities).toHaveLength(1);
    expect(body.identities[0]!).toMatchObject({
      id: IDENTITY.id,
      channel: 'email',
      channelIdentifier: 'alice@example.com',
      label: 'Work',
      verified: true,
      status: 'active',
      source: 'email_participant',
      verifiedAt: '2024-02-02T03:04:05.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
  });

  it('returns an empty array when the contact has no identities', async () => {
    const svc = fakeContactService({
      getIdentitiesForContact: vi.fn().mockResolvedValue([]),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CID}/identities`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identities: [] });
  });

  it('returns 404 when the contact does not exist', async () => {
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(undefined),
      getIdentitiesForContact: vi.fn(),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CID}/identities`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a non-UUID contact id', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/not-a-uuid/identities',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const svc = fakeContactService();
    app = await build(svc);
    const res = await app.inject({
      method: 'GET',
      url: `/api/contacts/${CID}/identities`,
    });
    expect(res.statusCode).toBe(401);
  });
});

function makeIdentity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    contactId: '11111111-1111-4111-8111-111111111111',
    channel: 'slack',
    channelIdentifier: 'U_CEO',
    label: null,
    verified: true,
    verifiedAt: new Date('2024-01-02T00:00:00Z'),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date('2024-01-02T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

describe('POST /api/contacts/:id/identities — link (#1514)', () => {
  let app: FastifyInstance;
  const CID = '11111111-1111-4111-8111-111111111111';
  const contact = { ...BASE_CONTACT, id: CID };
  afterEach(async () => {
    await app?.close();
  });

  it('links a verified ceo_stated identity and returns 201', async () => {
    const linked = makeIdentity({ contactId: CID });
    const linkIdentity = vi.fn().mockResolvedValue(linked);
    const svc = fakeContactService({
      linkIdentity,
      getContact: vi.fn().mockResolvedValue(contact),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: `/api/contacts/${CID}/identities`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'slack', channelIdentifier: 'U_CEO' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().identity.channel).toBe('slack');
    expect(res.json().identity.verified).toBe(true);
    expect(linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: CID,
      channel: 'slack',
      channelIdentifier: 'U_CEO',
      source: 'ceo_stated',
      verified: true,
    }));
  });

  it('rejects an unknown channel with 400', async () => {
    const svc = fakeContactService({ getContact: vi.fn().mockResolvedValue(contact) });
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: `/api/contacts/${CID}/identities`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'discord', channelIdentifier: 'x' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the identity is already linked elsewhere', async () => {
    const err = Object.assign(new Error('duplicate'), { code: '23505' });
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(contact),
      linkIdentity: vi.fn().mockRejectedValue(err),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: `/api/contacts/${CID}/identities`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'slack', channelIdentifier: 'U_CEO' }),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /api/contacts/:id/identities/:identityId — verify/status (#1514)', () => {
  let app: FastifyInstance;
  const CID = '11111111-1111-4111-8111-111111111111';
  const contact = { ...BASE_CONTACT, id: CID };
  afterEach(async () => {
    await app?.close();
  });

  it('verifies an unverified identity', async () => {
    const existing = makeIdentity({ contactId: CID, verified: false, verifiedAt: null, source: 'self_claimed' });
    const verified = { ...existing, verified: true, verifiedAt: new Date() };
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(contact),
      getIdentity: vi.fn().mockResolvedValue(existing),
      verifyIdentity: vi.fn().mockResolvedValue(verified),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${CID}/identities/${existing.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ verified: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.verified).toBe(true);
  });

  it('updates identity status', async () => {
    const existing = makeIdentity({ contactId: CID });
    const updated = { ...existing, status: 'defunct' as const };
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(contact),
      getIdentity: vi.fn().mockResolvedValue(existing),
      setIdentityStatus: vi.fn().mockResolvedValue(updated),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/contacts/${CID}/identities/${existing.id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'defunct' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.status).toBe('defunct');
  });
});

describe('DELETE /api/contacts/:id/identities/:identityId — unlink (#1514)', () => {
  let app: FastifyInstance;
  const CID = '11111111-1111-4111-8111-111111111111';
  const contact = { ...BASE_CONTACT, id: CID };
  afterEach(async () => {
    await app?.close();
  });

  it('unlinks an identity owned by the contact', async () => {
    const existing = makeIdentity({ contactId: CID });
    const unlinkIdentity = vi.fn().mockResolvedValue(true);
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(contact),
      getIdentity: vi.fn().mockResolvedValue(existing),
      unlinkIdentity,
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${CID}/identities/${existing.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(unlinkIdentity).toHaveBeenCalledWith(existing.id);
  });

  it('returns 404 when the identity belongs to another contact', async () => {
    const existing = makeIdentity({ contactId: '33333333-3333-4333-8333-333333333333' });
    const svc = fakeContactService({
      getContact: vi.fn().mockResolvedValue(contact),
      getIdentity: vi.fn().mockResolvedValue(existing),
      unlinkIdentity: vi.fn(),
    });
    app = await build(svc);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${CID}/identities/${existing.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/contacts/merge — merge lookalikes (#1514)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const PRIMARY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SECONDARY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('defaults to dryRun and returns a golden-record preview', async () => {
    const mergeContacts = vi.fn().mockResolvedValue({
      primaryContactId: PRIMARY,
      secondaryContactId: SECONDARY,
      dryRun: true,
      goldenRecord: {
        displayName: 'Principal',
        role: null,
        notes: null,
        tier: 'principal',
        identities: [makeIdentity()],
        authOverrides: [],
      },
    });
    const svc = fakeContactService({ mergeContacts });
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts/merge',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ primaryContactId: PRIMARY, secondaryContactId: SECONDARY }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dryRun).toBe(true);
    expect(res.json().goldenRecord.identityCount).toBe(1);
    expect(mergeContacts).toHaveBeenCalledWith(PRIMARY, SECONDARY, true);
  });

  it('commits when dryRun is false', async () => {
    const mergeContacts = vi.fn().mockResolvedValue({
      primaryContactId: PRIMARY,
      secondaryContactId: SECONDARY,
      dryRun: false,
      mergedAt: new Date('2024-06-01T00:00:00Z'),
      goldenRecord: {
        displayName: 'Principal',
        role: null,
        notes: null,
        tier: 'principal',
        identities: [],
        authOverrides: [],
      },
    });
    const svc = fakeContactService({ mergeContacts });
    app = await build(svc);
    const res = await app.inject({
      method: 'POST',
      url: '/api/contacts/merge',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        primaryContactId: PRIMARY,
        secondaryContactId: SECONDARY,
        dryRun: false,
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dryRun).toBe(false);
    expect(res.json().mergedAt).toBe('2024-06-01T00:00:00.000Z');
    expect(mergeContacts).toHaveBeenCalledWith(PRIMARY, SECONDARY, false);
  });
});

// ── Node merge routes (#2233) ────────────────────────────────────────────────

const SURVIVOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ABSORBED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function fakeMergeService(overrides: Partial<NodeMergeApi> = {}): NodeMergeApi {
  return {
    preview: vi.fn().mockResolvedValue({ dryRun: true, planToken: 'tok' }),
    apply: vi.fn().mockResolvedValue({ dryRun: false, survivorId: SURVIVOR, absorbedId: ABSORBED }),
    candidates: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as NodeMergeApi;
}

async function buildWithMerge(
  mergeService: NodeMergeApi | undefined,
  pool: Pool = makeFakePool(),
  contacts: ContactService = fakeContactService({
    findContactBySystemRole: vi.fn().mockResolvedValue({ ...BASE_CONTACT, systemRole: 'principal' }),
  }),
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(knowledgeGraphRoutes, {
    pool,
    logger: stubLogger,
    webAppBootstrapSecret: BOOTSTRAP,
    secureCookies: false,
    contactService: contacts,
    sessions: new Map(),
    nodeMergeService: mergeService,
    bus: { async publish() { /* login audit is not under test */ } } as unknown as EventBus,
  });
  return app;
}

function postMerge(app: FastifyInstance, body: Record<string, unknown>, headers: Record<string, string> = auth) {
  return app.inject({
    method: 'POST',
    url: '/api/kg/nodes/merge',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/kg/nodes/merge (#2233)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('requires authentication', async () => {
    const svc = fakeMergeService();
    app = await buildWithMerge(svc);
    const res = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED }, {});
    expect(res.statusCode).toBe(401);
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it('defaults to a dry-run preview', async () => {
    const svc = fakeMergeService();
    app = await buildWithMerge(svc);
    const res = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dryRun: true, planToken: 'tok' });
    expect(svc.preview).toHaveBeenCalledWith(SURVIVOR, ABSORBED);
    expect(svc.apply).not.toHaveBeenCalled();
  });

  it('applies with dryRun false, passing parsed resolutions and the console originator', async () => {
    const svc = fakeMergeService();
    app = await buildWithMerge(svc);
    const res = await postMerge(app, {
      survivorId: SURVIVOR,
      absorbedId: ABSORBED,
      dryRun: false,
      planToken: 'tok',
      resolutions: { label: 'absorbed', acknowledgements: ['principal_identity_transfer'] },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.apply).toHaveBeenCalledWith(expect.objectContaining({
      survivorId: SURVIVOR,
      absorbedId: ABSORBED,
      planToken: 'tok',
      resolutions: { label: 'absorbed', acknowledgements: ['principal_identity_transfer'] },
      actor: expect.objectContaining({ contactId: BASE_CONTACT.id, systemRole: 'principal', channel: 'console' }),
    }));
  });

  it.each([
    [{ survivorId: 'nope', absorbedId: ABSORBED }],
    [{ survivorId: SURVIVOR, absorbedId: SURVIVOR }],
    [{ survivorId: SURVIVOR, absorbedId: ABSORBED, dryRun: 'false' }],
    [{ survivorId: SURVIVOR, absorbedId: ABSORBED, dryRun: false }],
    [{ survivorId: SURVIVOR, absorbedId: ABSORBED, dryRun: false, planToken: 'tok', resolutions: { label: 'x' } }],
  ])('rejects a malformed request with 400 invalid_request (%j)', async (body) => {
    const svc = fakeMergeService();
    app = await buildWithMerge(svc);
    const res = await postMerge(app, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    expect(svc.apply).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidResolutionError('ack_required', 'ack'), 400, 'ack_required'],
    [new InvalidResolutionError('unknown_resolution', 'unknown'), 400, 'unknown_resolution'],
    [new NodeNotFoundError(ABSORBED), 404, 'node_not_found'],
    [new StalePreviewError(), 409, 'stale_preview'],
    [new MergeBlockedError([{ code: 'agent_node', message: 'no' }]), 422, 'blocked'],
  ])('maps %s to its status and code', async (err, status, code) => {
    const svc = fakeMergeService({ apply: vi.fn().mockRejectedValue(err) });
    app = await buildWithMerge(svc);
    const res = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED, dryRun: false, planToken: 'tok' });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
    if (status === 422) expect(res.json().blockers).toEqual([{ code: 'agent_node', message: 'no' }]);
  });

  it('maps a missing node on preview to 404 and an unexpected failure to 500', async () => {
    app = await buildWithMerge(fakeMergeService({ preview: vi.fn().mockRejectedValue(new NodeNotFoundError(SURVIVOR)) }));
    const notFound = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().code).toBe('node_not_found');
    await app.close();

    app = await buildWithMerge(fakeMergeService({ preview: vi.fn().mockRejectedValue(new Error('db down')) }));
    const boom = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED });
    expect(boom.statusCode).toBe(500);
    expect(boom.json().error).not.toContain('db down');
  });

  it('names the failed step in the 500: preview vs merge', async () => {
    app = await buildWithMerge(fakeMergeService({
      preview: vi.fn().mockRejectedValue(new Error('db down')),
      apply: vi.fn().mockRejectedValue(new Error('db down')),
    }));
    const preview = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED });
    expect(preview.statusCode).toBe(500);
    expect(preview.json()).toEqual({ error: 'Failed to preview node merge.' });
    const apply = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED, dryRun: false, planToken: 'tok' });
    expect(apply.statusCode).toBe(500);
    expect(apply.json()).toEqual({ error: 'Failed to merge nodes.' });
  });

  it('answers 503 when no merge service is wired', async () => {
    app = await buildWithMerge(undefined);
    const res = await postMerge(app, { survivorId: SURVIVOR, absorbedId: ABSORBED });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('unavailable');
  });
});

describe('GET /api/kg/nodes/:id/merge-candidates (#2233)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('requires authentication', async () => {
    app = await buildWithMerge(fakeMergeService());
    const res = await app.inject({ method: 'GET', url: `/api/kg/nodes/${SURVIVOR}/merge-candidates` });
    expect(res.statusCode).toBe(401);
  });

  it('defaults the limit to 8, caps it at 20, and wraps the list', async () => {
    const candidates = vi.fn().mockResolvedValue([{ node: { id: ABSORBED }, score: 1, reasons: ['same_label'] }]);
    app = await buildWithMerge(fakeMergeService({ candidates }));
    const res = await app.inject({ method: 'GET', url: `/api/kg/nodes/${SURVIVOR}/merge-candidates`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ candidates: [{ node: { id: ABSORBED }, score: 1, reasons: ['same_label'] }] });
    expect(candidates).toHaveBeenLastCalledWith(SURVIVOR, 8);
    await app.inject({ method: 'GET', url: `/api/kg/nodes/${SURVIVOR}/merge-candidates?limit=500`, headers: auth });
    expect(candidates).toHaveBeenLastCalledWith(SURVIVOR, 20);
  });

  it('rejects a malformed id with 400 and maps a missing node to 404', async () => {
    app = await buildWithMerge(fakeMergeService({ candidates: vi.fn().mockRejectedValue(new NodeNotFoundError(SURVIVOR)) }));
    const bad = await app.inject({ method: 'GET', url: '/api/kg/nodes/nope/merge-candidates', headers: auth });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: `/api/kg/nodes/${SURVIVOR}/merge-candidates`, headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('node_not_found');
  });
});

describe('GET /api/kg/nodes and /api/kg/graph — merge-aware (#2233)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const nodeRow = {
    id: SURVIVOR,
    type: 'person',
    label: 'Jane',
    properties: {},
    confidence: 0.7,
    decay_class: 'slow_decay',
    source: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    last_confirmed_at: '2026-01-01T00:00:00.000Z',
    sensitivity: 'internal',
  };

  it('excludes merge tombstones only — like /graph — and returns aliases, identitySource and archived', async () => {
    const pool = makeFakePool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        { ...nodeRow, aliases: ['jd'], identity_source: 'contact', archived_at: null },
        // A decayed archived node (no merged_into) is still listed, flagged archived.
        { ...nodeRow, id: ABSORBED, aliases: null, identity_source: 'label', archived_at: '2026-10-21T00:00:00.000Z' },
      ],
      rowCount: 2,
    } as never);
    app = await buildWithMerge(fakeMergeService(), pool);
    const res = await app.inject({ method: 'GET', url: '/api/kg/nodes?query=jane', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes[0]).toMatchObject({ aliases: ['jd'], identitySource: 'contact', archived: false });
    expect(res.json().nodes[1]).toMatchObject({ id: ABSORBED, aliases: [], archived: true });
    expect(res.json().nodes[1].archived_at).toBeUndefined();
    const sql = String(vi.mocked(pool.query).mock.calls[0]![0]);
    expect(sql).toContain("NOT (kg_nodes.archived_at IS NOT NULL AND kg_nodes.properties->>'merged_into' IS NOT NULL)");
    expect(sql).not.toMatch(/WHERE\s+archived_at IS NULL/);
  });

  it('searches aliases case-insensitively and excludes facts on request, all parameterized', async () => {
    const pool = makeFakePool();
    app = await buildWithMerge(fakeMergeService(), pool);
    const res = await app.inject({ method: 'GET', url: '/api/kg/nodes?query=Janie&exclude_facts=true', headers: auth });
    expect(res.statusCode).toBe(200);
    const [sql, params] = vi.mocked(pool.query).mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/unnest\(aliases\)[\s\S]*ILIKE '%' \|\| \$2 \|\| '%'/);
    expect(sql).toMatch(/NOT \$4::boolean OR type <> 'fact'/);
    expect(sql).not.toContain('Janie');
    expect(params).toEqual([null, 'Janie', 50, true]);

    // Facts stay in the list by default.
    await app.inject({ method: 'GET', url: '/api/kg/nodes?query=jane', headers: auth });
    expect((vi.mocked(pool.query).mock.calls[1]! as unknown as [string, unknown[]])[1]).toEqual([null, 'jane', 50, false]);
  });

  it('returns 404 node_merged with mergedInto and the absorbed label for a merged-away node', async () => {
    const pool = makeFakePool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ ...nodeRow, id: ABSORBED, label: 'J. Doe', archived_at: '2026-10-21T00:00:00.000Z', properties: { merged_into: SURVIVOR } }],
      rowCount: 1,
    } as never);
    app = await buildWithMerge(fakeMergeService(), pool);
    const res = await app.inject({ method: 'GET', url: `/api/kg/graph?node_id=${ABSORBED}`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: `Node ${ABSORBED} was merged into ${SURVIVOR}.`,
      code: 'node_merged',
      mergedInto: SURVIVOR,
      label: 'J. Doe',
    });
  });

  it('still draws an archived node that was not merged, flagged archived, with its aliases', async () => {
    const pool = makeFakePool();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ ...nodeRow, aliases: ['jd'], archived_at: '2026-10-21T00:00:00.000Z' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    app = await buildWithMerge(fakeMergeService(), pool);
    const res = await app.inject({ method: 'GET', url: `/api/kg/graph?node_id=${SURVIVOR}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toHaveLength(1);
    expect(res.json().nodes[0].archived_at).toBeUndefined();
    expect(res.json().nodes[0]).toMatchObject({ aliases: ['jd'], archived: true });
  });

  it('keeps merge tombstones out of the traversal and the top-N graph, and marks live nodes unarchived', async () => {
    const pool = makeFakePool();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ ...nodeRow, aliases: null, archived_at: null }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      // The two graph-totals queries (#2479).
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ ...nodeRow, aliases: ['jd'], archived_at: null }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    app = await buildWithMerge(fakeMergeService(), pool);

    const traversal = await app.inject({ method: 'GET', url: `/api/kg/graph?node_id=${SURVIVOR}`, headers: auth });
    expect(traversal.statusCode).toBe(200);
    expect(traversal.json().nodes[0]).toMatchObject({ aliases: [], archived: false });
    const traversalSql = String(vi.mocked(pool.query).mock.calls[0]![0]);
    // The recursive step joins the far node and refuses tombstones, so they are neither
    // drawn nor walked through; edges are then limited to the nodes returned.
    expect(traversalSql).toMatch(/JOIN kg_nodes o ON o\.id = CASE/);
    expect(traversalSql).toContain("NOT (o.archived_at IS NOT NULL AND o.properties->>'merged_into' IS NOT NULL)");

    const topN = await app.inject({ method: 'GET', url: '/api/kg/graph', headers: auth });
    expect(topN.statusCode).toBe(200);
    expect(topN.json().nodes[0]).toMatchObject({ aliases: ['jd'], archived: false });
    const topNSql = String(vi.mocked(pool.query).mock.calls[4]![0]);
    expect(topNSql).toContain("NOT (n.archived_at IS NOT NULL AND n.properties->>'merged_into' IS NOT NULL)");
    // Decayed archived nodes are not filtered out — only tombstones are.
    expect(topNSql).not.toMatch(/WHERE\s+archived_at IS NULL/);
    const edgeSql = String(vi.mocked(pool.query).mock.calls[5]![0]);
    expect(edgeSql).toMatch(/source_node_id = ANY\(\$1::uuid\[\]\)\s+AND target_node_id = ANY\(\$1::uuid\[\]\)/);
  });
});
