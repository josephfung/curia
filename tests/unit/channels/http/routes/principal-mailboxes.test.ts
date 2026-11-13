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
import { hashToken, type SessionStore } from '../../../../../src/channels/http/session-auth.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

const view = (over: Partial<PrincipalMailboxView> = {}): PrincipalMailboxView => ({
  id: 'work', label: 'Work', address: 'boss@example.com', isDefault: true, triageStartAt: null, ...over,
});

const preview: RemovalPreview = {
  mailbox: view(), isDefault: true, isPrimaryEmail: false, stillOwnedDefault: false,
  otherLive: [view({ id: 'personal', label: 'Personal', isDefault: false })], primaryEmailCandidates: [], scopedRules: [], rulesUnreadable: false, calendars: [], calendarsUnreadable: false,
};

function makeOptions(over: Partial<PrincipalMailboxesRouteOptions> = {}): PrincipalMailboxesRouteOptions {
  return {
    mailboxes: { list: vi.fn(async () => [view()]), isFallbackActive: vi.fn(async () => false), pendingMigrationReason: vi.fn(() => null) },
    store: { relabel: vi.fn(async () => {}) },
    admin: {
      add: vi.fn(async () => ({ ok: true as const, mailbox: view() })),
      setDefault: vi.fn(async () => ({})),
      replaceGrant: vi.fn(async () => ({ ok: true as const })),
      removalPreview: vi.fn(async () => preview),
      remove: vi.fn(async () => ({ cleanupIncomplete: [] })),
    },
    lookupGrant: vi.fn(async () => ({ email: 'boss@example.com', provider: 'google' })),
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
    bus: { publish: vi.fn(async () => {}) },
    ...over,
  };
}

/** The principal_mailbox.changed payloads the routes published, in order. */
function audited(opts: PrincipalMailboxesRouteOptions): Array<Record<string, unknown>> {
  return vi.mocked(opts.bus.publish).mock.calls.map(([layer, event]) => {
    expect(layer).toBe('system');
    expect(event.type).toBe('principal_mailbox.changed');
    return event.payload as unknown as Record<string, unknown>;
  });
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

  it('GET marks the fallback view pending_migration', async () => {
    await build(makeOptions({
      mailboxes: {
        list: vi.fn(async () => [view({ id: 'mailbox', label: 'Mailbox', address: '' })]),
        isFallbackActive: vi.fn(async () => true),
        pendingMigrationReason: vi.fn(() => 'The flat grant is not a Google account'),
      },
    }));
    const res = await req('GET', '/api/registry/principal-mailboxes');
    expect(res.json().mailboxes[0].pending_migration_reason).toBe('The flat grant is not a Google account');
    expect(res.json().mailboxes).toEqual([expect.objectContaining({ id: 'mailbox', pending_migration: true })]);
  });

  it('never logs or returns a grant id when the lookup fails', async () => {
    const lines: string[] = [];
    const stream = { write: (s: string) => { lines.push(s); } };
    app = Fastify({ logger: { level: 'debug', stream } });
    const boom = () => { throw new Error('Nylas grant SECRET-GRANT-XYZ has no email address'); };
    // A Nylas SDK error carries the grant in its message and its own `url` property.
    const nylasBoom = () => {
      throw Object.assign(new Error('Request to grants/SECRET-GRANT-XYZ timed out'), {
        name: 'NylasSdkTimeoutError', url: 'https://api.us.nylas.com/v3/grants/SECRET-GRANT-XYZ',
      });
    };
    await app.register(principalMailboxesRoutes, makeOptions({
      lookupGrant: vi.fn(async () => boom()),
      admin: { ...makeOptions().admin, add: vi.fn(async () => nylasBoom()) },
    }));
    const a = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'SECRET-GRANT-XYZ' });
    const b = await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'W', grant_id: 'SECRET-GRANT-XYZ' });
    expect(a.statusCode).toBe(422);
    expect(b.statusCode).toBe(500);
    expect(a.body + b.body + lines.join('')).not.toContain('SECRET-GRANT-XYZ');
  });

  it('PATCH takes exactly one change per request and applies nothing otherwise', async () => {
    const opts = makeOptions();
    await build(opts);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { label: 'X', make_default: false })).statusCode).toBe(400);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { label: 'X', make_default: true })).statusCode).toBe(400);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: 'grant-0003', label: 'X' })).statusCode).toBe(400);
    expect(opts.store.relabel).not.toHaveBeenCalled();
    expect(opts.admin.setDefault).not.toHaveBeenCalled();
    expect(opts.admin.replaceGrant).not.toHaveBeenCalled();
  });

  it('POST adds a mailbox and returns 201', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'Work', grant_id: 'grant-0001', make_default: true });
    expect(res.statusCode).toBe(201);
    expect(opts.admin.add).toHaveBeenCalledWith({ id: 'work', label: 'Work', grantId: 'grant-0001', makeDefault: true });
    expect(res.json().mailbox.id).toBe('work');
    expect(res.body).not.toContain('grant-0001');
  });

  it('POST maps a refusal to 422 with the refusal code', async () => {
    const opts = makeOptions({
      admin: { ...makeOptions().admin, add: vi.fn(async () => ({ ok: false as const, refusal: 'address_is_another_contact' as const, detail: 'x belongs to another contact' })) },
    });
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'Work', grant_id: 'grant-0001' });
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
    expect((await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'W', grant_id: 'grant-0002' })).statusCode).toBe(503);
    expect((await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'grant-0002' })).statusCode).toBe(503);
  });

  it('POST /test returns email and provider, storing nothing', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'grant-0001' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'boss@example.com', provider: 'google' });
    expect(opts.admin.add).not.toHaveBeenCalled();
  });

  it('POST /test returns 422 when Nylas cannot read the grant', async () => {
    await build(makeOptions({ lookupGrant: vi.fn(async () => { throw new Error('404'); }) }));
    const res = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'grant-bad1' });
    expect(res.statusCode).toBe(422);
    expect(res.json().refusal).toBe('grant_unreadable');
    expect(res.body).not.toContain('grant-bad1');
  });

  it('PATCH relabels, or sets the default', async () => {
    const opts = makeOptions();
    await build(opts);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { label: 'Office' })).statusCode).toBe(200);
    expect(opts.store.relabel).toHaveBeenCalledWith('work', 'Office');
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { make_default: true })).statusCode).toBe(200);
    expect(opts.admin.setDefault).toHaveBeenCalledWith('work');
  });

  it('PATCH returns 200 with the warning when the change committed but the flat-key copy is pending', async () => {
    const opts = makeOptions({ admin: { ...makeOptions().admin, setDefault: vi.fn(async () => ({ warning: 'copy pending' })) } });
    await build(opts);
    const res = await req('PATCH', '/api/registry/principal-mailboxes/work', { make_default: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, warning: 'copy pending' });
  });

  it('rejects malformed grant ids and labels with control characters (F4)', async () => {
    const opts = makeOptions();
    await build(opts);
    for (const grant of ['short', 'has space-0000', 'https://x/grants/abc', 'a'.repeat(129)]) {
      expect((await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: grant })).statusCode, grant).toBe(400);
      expect((await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label: 'Work', grant_id: grant })).statusCode, grant).toBe(400);
      expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: grant })).statusCode, grant).toBe(400);
    }
    for (const label of ['Wo\nrk', 'Tab\there', 'x'.repeat(81)]) {
      expect((await req('POST', '/api/registry/principal-mailboxes', { id: 'work', label, grant_id: '8a1d2c3e-0000-4000-8000-000000000001' })).statusCode).toBe(400);
      expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { label })).statusCode).toBe(400);
    }
    expect((await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: '8a1d2c3e-0000-4000-8000-000000000001' })).statusCode).toBe(200);
    expect(opts.admin.add).not.toHaveBeenCalled();
    expect(opts.store.relabel).not.toHaveBeenCalled();
  });

  it('POST /test explains the failure by Nylas status, never by its text (silent-failure 7)', async () => {
    const cases: Array<[number | undefined, string, RegExp]> = [
      [401, 'NylasApiError', /API key/],
      [404, 'NylasApiError', /No such grant/],
      [503, 'NylasApiError', /did not answer/],
      [undefined, 'NylasSdkTimeoutError', /did not answer/],
    ];
    for (const [statusCode, name, detail] of cases) {
      await app?.close();
      await build(makeOptions({ lookupGrant: vi.fn(async () => { throw Object.assign(new Error('grants/grant-hidden-1'), { name, ...(statusCode ? { statusCode } : {}) }); }) }));
      const res = await req('POST', '/api/registry/principal-mailboxes/test', { grant_id: 'grant-0001' });
      expect(res.statusCode).toBe(422);
      expect(res.json().detail).toMatch(detail);
      expect(res.body).not.toContain('grant-hidden-1');
    }
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
    expect(res.json()).toEqual({ ok: true, removed: true, cleanup_incomplete: [] });
  });

  it('DELETE passes the rules choice and rejects a malformed one', async () => {
    const opts = makeOptions();
    await build(opts);
    const url = '/api/registry/principal-mailboxes/work';
    await req('DELETE', url, { still_owned: true, rules: 'delete' });
    expect(opts.admin.remove).toHaveBeenLastCalledWith(expect.objectContaining({ rules: 'delete' }));
    await req('DELETE', url, { still_owned: true, rules: { rescope_to: 'personal' } });
    expect(opts.admin.remove).toHaveBeenLastCalledWith(expect.objectContaining({ rules: { rescopeTo: 'personal' } }));
    vi.mocked(opts.admin.remove).mockClear();
    expect((await req('DELETE', url, { still_owned: true, rules: 'keep' })).statusCode).toBe(400);
    expect((await req('DELETE', url, { still_owned: true, rules: {} })).statusCode).toBe(400);
    expect(opts.admin.remove).not.toHaveBeenCalled();
  });

  it('DELETE reports unfinished cleanup as a 200, never a failure', async () => {
    const opts = makeOptions({ admin: { ...makeOptions().admin, remove: vi.fn(async () => ({ cleanupIncomplete: ['identity'] })) } });
    await build(opts);
    const res = await req('DELETE', '/api/registry/principal-mailboxes/work', { still_owned: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, removed: true, cleanup_incomplete: ['identity'] });
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

  it('PATCH grant_id replaces the grant and never echoes it', async () => {
    const opts = makeOptions();
    await build(opts);
    const res = await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: ' grant-new1 ' });
    expect(res.statusCode).toBe(200);
    expect(opts.admin.replaceGrant).toHaveBeenCalledWith('work', 'grant-new1');
    expect(opts.admin.setDefault).not.toHaveBeenCalled();
    expect(opts.store.relabel).not.toHaveBeenCalled();
    expect(res.body).not.toContain('grant-new1');
  });

  it('PATCH grant_id maps a refusal to 422 and applies nothing else', async () => {
    const opts = makeOptions({
      admin: { ...makeOptions().admin, replaceGrant: vi.fn(async () => ({ ok: false as const, refusal: 'address_mismatch' as const, detail: 'wrong account' })) },
    });
    await build(opts);
    const res = await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: 'grant-0002' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ refusal: 'address_mismatch', detail: 'wrong account' });
    expect(opts.admin.setDefault).not.toHaveBeenCalled();
    expect(opts.store.relabel).not.toHaveBeenCalled();
  });

  it('PATCH grant_id 400s when blank or not a string, 503s without a Nylas key', async () => {
    await build(makeOptions());
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: '  ' })).statusCode).toBe(400);
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: 5 })).statusCode).toBe(400);
    await app.close();
    await build(makeOptions({ lookupGrant: undefined }));
    expect((await req('PATCH', '/api/registry/principal-mailboxes/work', { grant_id: 'grant-0002' })).statusCode).toBe(503);
  });

  it('logs the message of a non-Nylas failure, but only the class of a Nylas one', async () => {
    const lines: string[] = [];
    const stream = { write: (s: string) => { lines.push(s); } };
    app = Fastify({ logger: { level: 'debug', stream } });
    await app.register(principalMailboxesRoutes, makeOptions({
      admin: {
        ...makeOptions().admin,
        remove: vi.fn(async () => { throw new Error('relation "principal_mailboxes" is locked'); }),
        removalPreview: vi.fn(async () => {
          throw Object.assign(new Error('grants/SECRET-GRANT-ABC not found'), { name: 'NylasApiError', statusCode: 404 });
        }),
      },
    }));
    expect((await req('DELETE', '/api/registry/principal-mailboxes/work', { still_owned: true })).statusCode).toBe(500);
    expect((await req('GET', '/api/registry/principal-mailboxes/work/removal-preview')).statusCode).toBe(500);
    const log = lines.join('');
    expect(log).toContain('relation \\"principal_mailboxes\\" is locked');
    expect(log).toContain('NylasApiError');
    expect(log).not.toContain('SECRET-GRANT-ABC');
  });

  // P11: every mailbox admin action leaves a two-stage audit row, like the vault's secret.changed.
  describe('audit (P11)', () => {
    const URL = '/api/registry/principal-mailboxes';

    it('add: requested before the change, completed after; never a grant id or address', async () => {
      const opts = makeOptions();
      await build(opts);
      const order: string[] = [];
      vi.mocked(opts.bus.publish).mockImplementation(async (_l, e) => { order.push(`audit:${(e.payload as { stage: string }).stage}`); });
      vi.mocked(opts.admin.add).mockImplementation(async () => { order.push('add'); return { ok: true as const, mailbox: view() }; });
      expect((await req('POST', URL, { id: 'work', label: 'Work', grant_id: 'grant-secret-123' })).statusCode).toBe(201);
      expect(order).toEqual(['audit:requested', 'add', 'audit:completed']);
      expect(audited(opts)).toEqual([
        { mailboxId: 'work', action: 'add', stage: 'requested', initiatedBy: 'bootstrap_secret' },
        { mailboxId: 'work', action: 'add', stage: 'completed', initiatedBy: 'bootstrap_secret' },
      ]);
      expect(JSON.stringify(vi.mocked(opts.bus.publish).mock.calls)).not.toMatch(/grant-secret-123|boss@example\.com/);
    });

    it('keeps the session actor on the completed row when the session is revoked mid-change', async () => {
      const sessions: SessionStore = new Map([[hashToken('tok-1'), { id: 'sess-1', expiresAt: Date.now() + 60_000, renewedAt: Date.now() }]]);
      const opts = makeOptions({ sessions });
      vi.mocked(opts.admin.add).mockImplementation(async () => { sessions.clear(); return { ok: true as const, mailbox: view() }; });
      app = Fastify();
      app.addHook('onRequest', async (request) => { (request as unknown as { cookies: Record<string, string> }).cookies = { curia_session: 'tok-1' }; });
      await app.register(principalMailboxesRoutes, opts);
      expect((await req('POST', URL, { id: 'work', label: 'Work', grant_id: 'grant-secret-123' })).statusCode).toBe(201);
      expect(audited(opts).map((p) => [p.stage, p.initiatedBy, p.actorSessionId])).toEqual([
        ['requested', 'session', 'sess-1'],
        ['completed', 'session', 'sess-1'],
      ]);
    });

    it('a malformed id or rescope target is refused before anything is audited (SEC-L5)', async () => {
      const opts = makeOptions();
      await build(opts);
      const long = 'x'.repeat(500);
      expect((await req('POST', URL, { id: `Bad Id ${long}`, label: 'Work', grant_id: 'grant-secret-123' })).statusCode).toBe(400);
      expect((await req('PATCH', `${URL}/${'x'.repeat(40)}`, { label: 'New' })).statusCode).toBe(400);
      expect((await req('DELETE', `${URL}/NOT_AN_ID`, { still_owned: true })).statusCode).toBe(400);
      expect((await req('DELETE', `${URL}/work`, { still_owned: true, rules: { rescope_to: 'Bad Target!' } })).statusCode).toBe(400);
      const badDefault = await req('DELETE', `${URL}/work`, { still_owned: true, new_default_id: '../x' });
      expect(badDefault.statusCode).toBe(400);
      expect(badDefault.json().error).toMatch(/^new_default_id must be a mailbox id/);
      expect(opts.bus.publish).not.toHaveBeenCalled();
    });

    it('a refused add leaves only the requested row', async () => {
      const opts = makeOptions({ admin: { ...makeOptions().admin, add: vi.fn(async () => ({ ok: false as const, refusal: 'address_is_another_contact' as const, detail: 'x' })) } });
      await build(opts);
      expect((await req('POST', URL, { id: 'work', label: 'Work', grant_id: 'grant-secret-123' })).statusCode).toBe(422);
      expect(audited(opts).map((p) => p.stage)).toEqual(['requested']);
    });

    it('relabel, set_default and replace_grant are audited', async () => {
      const opts = makeOptions({ admin: { ...makeOptions().admin, setDefault: vi.fn(async () => ({ warning: 'copy pending' })) } });
      await build(opts);
      await req('PATCH', `${URL}/work`, { label: 'Office' });
      await req('PATCH', `${URL}/work`, { make_default: true });
      await req('PATCH', `${URL}/work`, { grant_id: 'grant-new12345' });
      expect(audited(opts).map((p) => `${String(p.action)}:${String(p.stage)}`)).toEqual([
        'relabel:requested', 'relabel:completed',
        'set_default:requested', 'set_default:completed',
        'replace_grant:requested', 'replace_grant:completed',
      ]);
      expect(audited(opts)[3]).toMatchObject({ warning: true });
      expect(JSON.stringify(vi.mocked(opts.bus.publish).mock.calls)).not.toContain('grant-new12345');
    });

    it('remove records the rules choice and the unfinished cleanup (the rules rewrite)', async () => {
      const opts = makeOptions({ admin: { ...makeOptions().admin, remove: vi.fn(async () => ({ cleanupIncomplete: ['inbox_rules'] })) } });
      await build(opts);
      await req('DELETE', `${URL}/work`, { still_owned: true, rules: { rescope_to: 'personal' } });
      expect(audited(opts)).toEqual([
        { mailboxId: 'work', action: 'remove', stage: 'requested', initiatedBy: 'bootstrap_secret', stillOwned: true, rules: 'rescope', rulesRescopeTo: 'personal' },
        { mailboxId: 'work', action: 'remove', stage: 'completed', initiatedBy: 'bootstrap_secret', stillOwned: true, rules: 'rescope', rulesRescopeTo: 'personal', cleanupIncomplete: ['inbox_rules'] },
      ]);
    });

    it('refuses the change when the requested row cannot be written', async () => {
      const opts = makeOptions({ bus: { publish: vi.fn(async () => { throw new Error('audit down'); }) } });
      await build(opts);
      const res = await req('DELETE', `${URL}/work`, { still_owned: false });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatch(/could not be audited/);
      expect(opts.admin.remove).not.toHaveBeenCalled();
    });

    it('a missed completed row is logged, not turned into a failure', async () => {
      const publish = vi.fn(async (_l: string, e: { payload: { stage: string } }) => { if (e.payload.stage === 'completed') throw new Error('audit down'); });
      const opts = makeOptions({ bus: { publish } as never });
      await build(opts);
      expect((await req('PATCH', `${URL}/work`, { make_default: true })).statusCode).toBe(200);
      expect(opts.admin.setDefault).toHaveBeenCalled();
    });

    it('a failed change after the requested row gets no completed row', async () => {
      const opts = makeOptions({ admin: { ...makeOptions().admin, replaceGrant: vi.fn(async () => { throw new Error('vault down'); }) } });
      await build(opts);
      expect((await req('PATCH', `${URL}/work`, { grant_id: 'grant-new12345' })).statusCode).toBe(500);
      expect(audited(opts).map((p) => p.stage)).toEqual(['requested']);
    });
  });
});
