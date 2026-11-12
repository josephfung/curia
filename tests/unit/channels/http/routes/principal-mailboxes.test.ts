// principal-mailboxes.test.ts — the console routes for the principal's Gmail mailboxes (#2475),
// against fake admin / service / store. Auth uses the bootstrap-secret header like email-accounts.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  principalMailboxesRoutes,
  type PrincipalMailboxesRouteOptions,
} from '../../../../../src/channels/http/routes/principal-mailboxes.js';
import { MailboxRemovalError, type RemovalPreview } from '../../../../../src/principal-mailboxes/admin.js';
import { RemovedMailboxError, UnknownMailboxError } from '../../../../../src/principal-mailboxes/types.js';
import type { PrincipalMailboxView } from '../../../../../src/principal-mailboxes/service.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

const view = (over: Partial<PrincipalMailboxView> = {}): PrincipalMailboxView => ({
  id: 'work', label: 'Work', address: 'boss@example.com', isDefault: true, triageStartAt: null, ...over,
});

const preview: RemovalPreview = {
  mailbox: view(), isDefault: true, isPrimaryEmail: false, stillOwnedDefault: false,
  otherLive: [view({ id: 'personal', label: 'Personal', isDefault: false })], scopedRules: [], calendars: [],
};

function makeOptions(over: Partial<PrincipalMailboxesRouteOptions> = {}): PrincipalMailboxesRouteOptions {
  return {
    mailboxes: { list: vi.fn(async () => [view()]) },
    store: { relabel: vi.fn(async () => {}) },
    admin: {
      add: vi.fn(async () => ({ ok: true as const, mailbox: view() })),
      setDefault: vi.fn(async () => {}),
      removalPreview: vi.fn(async () => preview),
      remove: vi.fn(async () => {}),
    },
    lookupGrant: vi.fn(async () => ({ email: 'boss@example.com', provider: 'google' })),
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
    ...over,
  };
}

describe('principal-mailboxes routes', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });
  async function build(opts: PrincipalMailboxesRouteOptions) {
    app = Fastify();
    await app.register(principalMailboxesRoutes, opts);
  }
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('401s without auth on every route', async () => {
    await build(makeOptions());
    for (const [m, u] of [
      ['GET', '/api/registry/principal-mailboxes'], ['POST', '/api/registry/principal-mailboxes'],
      ['POST', '/api/registry/principal-mailboxes/test'], ['PATCH', '/api/registry/principal-mailboxes/work'],
      ['GET', '/api/registry/principal-mailboxes/work/removal-preview'], ['DELETE', '/api/registry/principal-mailboxes/work'],
    ] as const) {
      const res = await app.inject({ method: m, url: u, payload: {} });
      expect(res.statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it('GET lists mailboxes and never includes a grant id', async () => {
    await build(makeOptions());
    const res = await req('GET', '/api/registry/principal-mailboxes');
    expect(res.statusCode).toBe(200);
    expect(res.json().mailboxes).toHaveLength(1);
    expect(res.body).not.toMatch(/grant/i);
  });

  it('POST adds a mailbox and returns 201', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'Work', grant_id: 'g1', make_default: true });
    expect(res.statusCode).toBe(201);
    expect(opts.admin.add).toHaveBeenCalledWith({ id: 'work', label: 'Work', grantId: 'g1', makeDefault: true });
    expect(res.json().mailbox.id).toBe('work');
    expect(res.body).not.toContain('g1');
  });

  it('POST maps a refusal to 422 with the refusal code', async () => {
    const opts = makeOptions({
      admin: { ...makeOptions().admin, add: vi.fn(async () => ({ ok: false as const, refusal: 'address_is_another_contact' as const, detail: 'x belongs to another contact' })) },
    });
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'Work', grant_id: 'g1' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ refusal: 'address_is_another_contact', detail: 'x belongs to another contact' });
  });

  it('POST 400s on missing fields', async () => {
    await build(makeOptions());
    const res = await req('POST', '/api/registry/principal-mailboxes', { id: 'work' });
    expect(res.statusCode).toBe(400);
  });

  it('POST add and test return 503 when no Nylas API key is configured', async () => {
    await build(makeOptions({ lookupGrant: undefined }));
    expect((await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'W', grant_id: 'g' })).statusCode).toBe(503);
    expect((await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'g' })).statusCode).toBe(503);
  });

  it('POST /test returns email and provider, storing nothing', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'g1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'boss@example.com', provider: 'google' });
    expect(opts.admin.add).not.toHaveBeenCalled();
  });

  it('POST /test returns 422 when Nylas cannot read the grant', async () => {
    await build(makeOptions({ lookupGrant: vi.fn(async () => { throw new Error('404'); }) }));
    const res = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'bad' });
    expect(res.statusCode).toBe(422);
    expect(res.json().refusal).toBe('grant_unreadable');
    expect(res.body).not.toContain('bad');
  });

  it('PATCH relabels and sets default', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('PATCH', '/api/registry/principal-mailboxes/work', { label: 'Office', make_default: true });
    expect(res.statusCode).toBe(200);
    expect(opts.store.relabel).toHaveBeenCalledWith('work', 'Office');
    expect(opts.admin.setDefault).toHaveBeenCalledWith('work');
  });

  it('PATCH maps unknown and removed ids to 404', async () => {
    const opts = makeOptions({ store: { relabel: vi.fn(async () => { throw new UnknownMailboxError('nope'); }) } });
    await build(opts);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/nope', { label: 'x' })).statusCode).toBe(404);
    await app.close();
    const opts2 = makeOptions({ admin: { ...makeOptions().admin, setDefault: vi.fn(async () => { throw new RemovedMailboxError('old', 'Old'); }) } });
    await build(opts2);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/old', { make_default: true })).statusCode).toBe(404);
  });

  it('PATCH 400s on an empty body or non-true make_default', async () => {
    await build(makeOptions());
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', {})).statusCode).toBe(400);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { make_default: false })).statusCode).toBe(400);
  });

  it('GET removal-preview returns the preview; 404 for unknown', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('GET', '/api/registry/principal-mailboxes/work/removal-preview');
    expect(res.statusCode).toBe(200);
    expect(res.json().stillOwnedDefault).toBe(false);
    await app.close();
    await build(makeOptions({ admin: { ...makeOptions().admin, removalPreview: vi.fn(async () => { throw new UnknownMailboxError('x'); }) } }));
    expect((await req('GET', '/api/registry/principal-mailboxes/x/removal-preview')).statusCode).toBe(404);
  });

  it('DELETE requires a boolean still_owned', async () => {
    const opts = makeOptions();
    await build(opts);
    expect((await req('DELETE', '/api/registry/principal-mailboxes/work', {})).statusCode).toBe(400);
    expect((await req('DELETE', '/api/registry/principal-mailboxes/work', { still_owned: 'yes' })).statusCode).toBe(400);
    expect(opts.admin.remove).not.toHaveBeenCalled();
  });

  it('DELETE removes with the given options', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('DELETE', '/api/registry/principal-mailboxes/work', { still_owned: false, new_default_id: 'personal', new_primary_email: 'a@example.com' });
    expect(res.statusCode).toBe(200);
    expect(opts.admin.remove).toHaveBeenCalledWith({ id: 'work', stillOwned: false, newDefaultId: 'personal', newPrimaryEmail: 'a@example.com' });
  });

  it('DELETE maps a removal precondition error to 422 and unknown to 404', async () => {
    await build(makeOptions({ admin: { ...makeOptions().admin, remove: vi.fn(async () => { throw new MailboxRemovalError('name a new default'); }) } }));
    const res = await req('DELETE', '/api/registry/principal-mailboxes/work', { still_owned: true });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ refusal: 'removal_precondition', detail: 'name a new default' });
    await app.close();
    await build(makeOptions({ admin: { ...makeOptions().admin, remove: vi.fn(async () => { throw new UnknownMailboxError('z'); }) } }));
    expect((await req('DELETE', '/api/registry/principal-mailboxes/z', { still_owned: true })).statusCode).toBe(404);
  });
});
