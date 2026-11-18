// Integration test — the Nylas hosted-auth callback (#2361) against real Postgres. Skips without
// DATABASE_URL.
//
// The registries are real: PrincipalMailboxStore, PrincipalMailboxAdmin, EmailAccountsRepo and
// MailboxSignInService, on their real tables. Nylas, the vault, contacts and the bus are fakes.
// The tables live in a throwaway schema, rebuilt empty before each test (copied from public with
// LIKE … INCLUDING ALL, so their CHECKs and unique indexes come along; foreign keys do not, which
// lets the fake contacts hand out identity ids): principal-mailboxes-store.test.ts asserts it is
// the only suite that commits rows to public.principal_mailboxes, and the "first ever" rule needs
// an empty table.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, type Mock } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashToken } from '../../src/channels/http/session-auth.js';
import { MailboxSignInService } from '../../src/nylas/mailbox-signin-service.js';
import { PrincipalMailboxStore } from '../../src/principal-mailboxes/store.js';
import { PrincipalMailboxAdmin, type PrincipalMailboxAdminDeps } from '../../src/principal-mailboxes/admin.js';
import { principalMailboxGrantSecretName } from '../../src/principal-mailboxes/secrets.js';
import { EmailAccountsRepo } from '../../src/channels/email/email-accounts-repo.js';
import { emailAccountGrantSecretName } from '../../src/channels/email/email-account-secrets.js';
import { NylasAppError, type NylasAppClient, type NylasGrantInfo } from '../../src/nylas/app-client.js';
import { MAILBOX_SIGNIN_SCOPES, type NylasSignInReadiness } from '../../src/nylas/signin-readiness.js';
import {
  handleMailboxSignInCallback,
  type MailboxSignInCallbackDeps,
} from '../../src/nylas/mailbox-signin-callback.js';
import type { BusEvent } from '../../src/bus/events.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const ORIGIN = 'https://curia.example.com';
const READY: NylasSignInReadiness = { ready: true, applicationId: 'app-123', region: 'us' };
const ORIGINATOR = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't', tier: 'principal' };

describeIf('mailbox sign-in callback', () => {
  const schema = `signin_cb_${randomBytes(4).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let schemaCreated = false;

  // Per-test state, rebuilt in beforeEach.
  let vault: Map<string, string>;
  let grants: Map<string, NylasGrantInfo>;
  let codes: Map<string, string>;
  let published: BusEvent[];
  let logLines: Array<Record<string, unknown>>;
  let rawLog: string[];
  let exchangeCode: Mock<NylasAppClient['exchangeCode']>;
  let deleteGrant: Mock<NylasAppClient['deleteGrant']>;
  let scheduleProcessExit: Mock<(delayMs: number) => void>;
  let secretsSet: Mock<(name: string, value: string) => Promise<void>>;
  let store: PrincipalMailboxStore;
  let repo: EmailAccountsRepo;
  let deps: MailboxSignInCallbackDeps;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(admin);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema},public` });
  });

  afterAll(async () => {
    await pool?.end();
    try {
      if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    // A fresh private schema per test: the tables start empty without touching shared rows.
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    for (const t of ['principal_mailboxes', 'email_accounts', 'mailbox_signin_tokens']) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
    }
    vault = new Map();
    grants = new Map();
    codes = new Map();
    published = [];
    logLines = [];
    rawLog = [];
    const logger = pino({ level: 'debug' }, {
      write(s: string) {
        rawLog.push(s);
        logLines.push(JSON.parse(s) as Record<string, unknown>);
      },
    });

    exchangeCode = vi.fn<NylasAppClient['exchangeCode']>(async (input) => {
      const grantId = codes.get(input.code);
      if (grantId === undefined) throw new NylasAppError('Nylas exchange code failed: HTTP 400 (invalid_grant)', 400, 'invalid_grant');
      return { grantId, email: grants.get(grantId)?.email ?? null, scopes: [] };
    });
    deleteGrant = vi.fn<NylasAppClient['deleteGrant']>(async () => {});
    const getGrant = vi.fn(async (grantId: string) => {
      const g = grants.get(grantId);
      if (!g) throw new NylasAppError('Nylas get grant failed: HTTP 404', 404);
      return g;
    });
    scheduleProcessExit = vi.fn<(delayMs: number) => void>();

    secretsSet = vi.fn<(name: string, value: string) => Promise<void>>(async (name, value) => { vault.set(name, value); });
    const secrets = {
      get: async (name: string) => vault.get(name) ?? null,
      set: secretsSet,
      delete: async (name: string) => { vault.delete(name); },
    };
    store = new PrincipalMailboxStore(pool, logger);
    repo = new EmailAccountsRepo(pool);
    const contacts = {
      getContactWithIdentities: async () => ({ contact: { primaryEmail: 'boss@example.com' }, identities: [] }),
      linkIdentity: async () => ({ id: randomUUID() }),
      resolveByChannelIdentity: async () => null,
      unlinkIdentity: async () => {},
      verifyIdentity: async () => {},
      setIdentityStatus: async () => {},
      updateContactFields: async () => {},
    } as unknown as PrincipalMailboxAdminDeps['contacts'];
    const principalAdmin = new PrincipalMailboxAdmin({
      store,
      secrets,
      contacts,
      principalContactId: 'ceo',
      curiaAccountAddresses: async () => (await repo.list()).map((a) => a.selfEmail),
      curiaAccountGrantIds: async () => {
        const ids: string[] = [];
        for (const a of await repo.list()) {
          const g = vault.get(emailAccountGrantSecretName(a.name));
          if (g) ids.push(g);
        }
        return ids;
      },
      lookupGrant: async (grantId) => {
        const g = grants.get(grantId);
        if (!g) throw new Error('no grant');
        return { email: g.email, provider: g.provider };
      },
      logger,
    });

    deps = {
      signIn: new MailboxSignInService({ pool, logger, appOrigin: ORIGIN, readiness: async () => READY }),
      readiness: async () => READY,
      readApiKey: async () => 'nyk_test_key',
      appOrigin: ORIGIN,
      makeClient: () => ({ exchangeCode, getGrant, deleteGrant }),
      principalStore: store,
      principalAdmin,
      emailAccounts: repo,
      secrets,
      bus: { publish: async (_layer, event) => { published.push(event); } },
      scheduleProcessExit,
      logger,
    };
  });

  /** A token row inserted directly, as the service would mint it. */
  async function token(over: {
    target?: 'principal' | 'curia';
    expectedEmail?: string | null;
    label?: string | null;
    expired?: boolean;
    origin?: boolean;
  } = {}): Promise<string> {
    const raw = randomBytes(16).toString('base64url');
    await pool.query(
      `INSERT INTO mailbox_signin_tokens
         (token_hash, target, expected_email, mailbox_label, expires_at,
          conversation_id, channel_id, agent_id, task_event_id, originator)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7, $8, $9, $10)`,
      [
        hashToken(raw),
        over.target ?? 'principal',
        over.expectedEmail === undefined ? 'boss@example.com' : over.expectedEmail,
        over.label ?? null,
        over.expired ? -5 : 60,
        over.origin === false ? null : 'conv-1',
        over.origin === false ? null : 'email',
        over.origin === false ? null : 'coordinator',
        over.origin === false ? null : 'task-evt-1',
        over.origin === false ? null : ORIGINATOR,
      ],
    );
    return raw;
  }

  /** Nylas will hand back `grantId` for `code`, a grant for `email` with the given scopes. */
  function nylasGrant(code: string, grantId: string, email: string, over: Partial<NylasGrantInfo> = {}): void {
    codes.set(code, grantId);
    grants.set(grantId, { email, provider: 'google', scopes: [...MAILBOX_SIGNIN_SCOPES], status: 'valid', ...over });
  }

  const ofType = (type: string) => published.filter((e) => e.type === type);
  const finished = () => ofType('mailbox_signin.finished');
  /** Every outcome publishes exactly one mailbox_signin.finished, and no event carries a grant id. */
  function expectOneFinished(outcome: string): Record<string, unknown> {
    const f = finished();
    expect(f).toHaveLength(1);
    const payload = f[0]!.payload as unknown as Record<string, unknown>;
    expect(payload['outcome']).toBe(outcome);
    const all = JSON.stringify(published);
    for (const g of grants.keys()) expect(all).not.toContain(g);
    return payload;
  }
  function expectNoGrantInLogs(): void {
    const all = rawLog.join('\n');
    for (const g of grants.keys()) expect(all).not.toContain(g);
    for (const c of codes.keys()) expect(all).not.toContain(c);
  }

  it('connects the first-ever principal mailbox: row, vault grant, one principal_mailbox.connected', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'Boss@Example.com');
    const state = await token({ label: 'Work' });
    const res = await handleMailboxSignInCallback({ state, code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', target: 'principal', mailboxId: 'example', restartScheduled: false });
    const live = await store.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'example', label: 'Work', address: 'boss@example.com', isDefault: true });
    expect(vault.get(principalMailboxGrantSecretName('example'))).toBe('grant-boss-0001');
    expect(ofType('principal_mailbox.connected')).toHaveLength(1);
    expect(ofType('principal_mailbox.connected')[0]!.payload).toEqual({ mailboxId: 'example' });
    // Audited through the console's two-stage event, attributed to the sign-in callback.
    expect(ofType('principal_mailbox.changed').map((e) => (e.payload as { stage: string }).stage)).toEqual(['requested', 'completed']);
    expect(ofType('principal_mailbox.changed')[0]!.payload).toMatchObject({ action: 'add', mailboxId: 'example', initiatedBy: 'signin_callback' });
    const payload = expectOneFinished('connected');
    expect(payload).toMatchObject({
      target: 'principal', mailboxId: 'example', conversationId: 'conv-1', channelId: 'email',
      agentId: 'coordinator', taskEventId: 'task-evt-1', originator: ORIGINATOR,
    });
    expect(finished()[0]!.parentEventId).toBe('task-evt-1');
    expect(exchangeCode).toHaveBeenCalledWith({ clientId: 'app-123', code: 'code-1', redirectUri: `${ORIGIN}/api/mailbox-signin/callback` });
    expect(deleteGrant).not.toHaveBeenCalled();
    expectNoGrantInLogs();
  });

  it('adds a second mailbox with no principal_mailbox.connected event, keeping the default', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    published = [];
    nylasGrant('code-2', 'grant-work-0002', 'boss@acme.com');
    const res = await handleMailboxSignInCallback({ state: await token({ expectedEmail: 'boss@acme.com' }), code: 'code-2' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', mailboxId: 'acme' });
    const live = await store.listLive();
    expect(live.map((m) => [m.id, m.isDefault])).toEqual([['example', true], ['acme', false]]);
    expect(live.find((m) => m.id === 'acme')?.label).toBe('Primary');
    expect(ofType('principal_mailbox.connected')).toHaveLength(0);
    expectOneFinished('connected');
  });

  it('never reuses a removed mailbox id: a tombstoned "example" makes the new one "example-2"', async () => {
    await store.insert({ id: 'example', label: 'Old', address: 'old@example.com', provider: 'google', isDefault: true, triageStartAt: null, addedIdentityId: null });
    await store.tombstone('example', null);
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', mailboxId: 'example-2' });
    // A removed row exists, so this is not the first-ever mailbox; none is live, so it is the default.
    expect(ofType('principal_mailbox.connected')).toHaveLength(0);
    expect((await store.listLive())[0]).toMatchObject({ id: 'example-2', isDefault: true });
  });

  it('re-auth that returns the stored grant id is reconnected with no write and no event', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    published = [];
    secretsSet.mockClear();
    nylasGrant('code-2', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-2' }, deps);
    expect(res).toMatchObject({ outcome: 'reconnected', mailboxId: 'example' });
    expect(secretsSet).not.toHaveBeenCalled();
    expect(ofType('principal_mailbox.connected')).toHaveLength(0);
    expect(ofType('principal_mailbox.changed')).toHaveLength(0);
    expect(deleteGrant).not.toHaveBeenCalled();
    expectOneFinished('reconnected');
  });

  it('re-auth with a new grant id for a live mailbox replaces its grant', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    published = [];
    nylasGrant('code-2', 'grant-boss-0099', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-2' }, deps);
    expect(res).toMatchObject({ outcome: 'reconnected', mailboxId: 'example' });
    expect(vault.get(principalMailboxGrantSecretName('example'))).toBe('grant-boss-0099');
    expect(ofType('principal_mailbox.changed').map((e) => (e.payload as { action: string }).action)).toEqual(['replace_grant', 'replace_grant']);
    expect(ofType('principal_mailbox.connected')).toHaveLength(0);
    expectOneFinished('reconnected');
  });

  it('wrong account: the stray grant is revoked and nothing is stored', async () => {
    nylasGrant('code-1', 'grant-stray-0003', 'someone@else.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).toHaveBeenCalledTimes(1);
    expect(deleteGrant).toHaveBeenCalledWith('grant-stray-0003');
    expect(await store.listLive()).toEqual([]);
    expect(vault.size).toBe(0);
    expectOneFinished('wrong_account');
    expectNoGrantInLogs();
  });

  it("wrong account whose grant is Curia's own email_accounts grant is NOT revoked (Review Focus 1)", async () => {
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-curia-0004');
    nylasGrant('code-1', 'grant-curia-0004', 'curia@office.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0004');
    expectOneFinished('wrong_account');
  });

  it("wrong account whose grant is another live principal mailbox's is NOT revoked", async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    published = [];
    nylasGrant('code-2', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token({ expectedEmail: 'boss@acme.com' }), code: 'code-2' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).not.toHaveBeenCalled();
    expectOneFinished('wrong_account');
  });

  it('an expired state with a code exchanges nothing and resumes with expired (Review Focus 2)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const state = await token({ expired: true });
    const res = await handleMailboxSignInCallback({ state, code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'expired', target: 'principal', restartScheduled: false });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await store.listLive()).toEqual([]);
    expect(expectOneFinished('expired')).toMatchObject({ conversationId: 'conv-1', agentId: 'coordinator' });
    // Spent: a replay of the same state is refused and publishes nothing more.
    published = [];
    expect((await handleMailboxSignInCallback({ state, code: 'code-1' }, deps)).outcome).toBe('failed');
    expect(finished()).toHaveLength(0);
  });

  it('error=admin_policy_enforced is admin_blocked and exchanges nothing (Review Focus 3)', async () => {
    const res = await handleMailboxSignInCallback({ state: await token(), error: 'admin_policy_enforced', code: 'code-x' }, deps);
    expect(res.outcome).toBe('admin_blocked');
    expect(exchangeCode).not.toHaveBeenCalled();
    expectOneFinished('admin_blocked');
  });

  it.each([
    [{ error: 'access_denied', error_description: 'admin_policy_enforced' }, 'admin_blocked'],
    [{ error: 'access_denied', error_description: 'Error 403: org_internal' }, 'org_internal'],
    [{ error: 'org_internal' }, 'org_internal'],
    [{ error: 'access_denied' }, 'cancelled'],
    [{ error: 'server_error', error_description: 'boom' }, 'failed'],
  ])('maps the provider error %j to %s without an exchange', async (q, outcome) => {
    const res = await handleMailboxSignInCallback({ state: await token(), ...q }, deps);
    expect(res.outcome).toBe(outcome);
    expect(exchangeCode).not.toHaveBeenCalled();
    expectOneFinished(outcome);
  });

  it('a principal link with no expected address is refused before any exchange (R4)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token({ expectedEmail: null }), code: 'code-1' }, deps);
    expect(res.outcome).toBe('refused');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(await store.listLive()).toEqual([]);
    expectOneFinished('refused');
  });

  it('a missing calendar scope is missing_scopes, revoked, nothing stored', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com', {
      scopes: MAILBOX_SIGNIN_SCOPES.filter((s) => !s.endsWith('/calendar')),
    });
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('missing_scopes');
    expect(deleteGrant).toHaveBeenCalledWith('grant-boss-0001');
    expect(await store.listLive()).toEqual([]);
    expect(vault.size).toBe(0);
    expectOneFinished('missing_scopes');
  });

  it('a non-Google grant is not_google and revoked', async () => {
    nylasGrant('code-1', 'grant-ms-0005', 'boss@example.com', { provider: 'microsoft' });
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('not_google');
    expect(deleteGrant).toHaveBeenCalledWith('grant-ms-0005');
    expectOneFinished('not_google');
  });

  it('a failing exchange (400) is failed: nothing stored, a warning logged without the code', async () => {
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-SECRET-unknown' }, deps);
    expect(res.outcome).toBe('failed');
    expect(await store.listLive()).toEqual([]);
    expect(vault.size).toBe(0);
    expect(deleteGrant).not.toHaveBeenCalled();
    const warn = logLines.find((l) => l['level'] === 40 && l['step'] === 'exchange');
    expect(warn).toMatchObject({ errName: 'NylasAppError', statusCode: 400 });
    expect(rawLog.join('\n')).not.toContain('code-SECRET-unknown');
    expectOneFinished('failed');
  });

  it('an unknown or replayed state is failed, exchanges nothing and publishes nothing', async () => {
    const res = await handleMailboxSignInCallback({ state: 'not-a-real-token', code: 'code-1' }, deps);
    expect(res).toEqual({ outcome: 'failed', restartScheduled: false });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(rawLog.join('\n')).not.toContain('not-a-real-token');
  });

  it('Curia target: an email_accounts row, its vault grant and a scheduled restart; a second run updates it', async () => {
    nylasGrant('code-1', 'grant-curia-0006', 'Assistant@Office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', target: 'curia', restartScheduled: true });
    expect(scheduleProcessExit).toHaveBeenCalledWith(3000);
    let rows = await repo.list();
    expect(rows).toHaveLength(1);
    // No account delivers notifications until one is named 'curia', so the first one takes it.
    expect(rows[0]).toMatchObject({ name: 'curia', selfEmail: 'assistant@office.com', enabled: true });
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0006');
    expect(expectOneFinished('connected')['target']).toBe('curia');
    expect(await store.listLive()).toEqual([]);

    published = [];
    await repo.update('curia', { enabled: false });
    nylasGrant('code-2', 'grant-curia-0007', 'assistant@office.com');
    const again = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-2' }, deps);
    expect(again).toMatchObject({ outcome: 'reconnected', restartScheduled: true });
    rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'curia', enabled: true });
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0007');
    expectOneFinished('reconnected');
    expectNoGrantInLogs();
  });

  it("a second Curia address gets a slug of its local part, suffixed on collision", async () => {
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    await repo.create({ name: 'ops-desk', selfEmail: 'other@office.com' });
    nylasGrant('code-1', 'grant-ops-0008', 'Ops.Desk@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res.outcome).toBe('connected');
    expect((await repo.findBySelfEmail('ops.desk@office.com'))?.name).toBe('ops-desk-2');
  });

  it("Curia target for an address that is a live principal mailbox is refused, nothing written", async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    published = [];
    nylasGrant('code-2', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-2' }, deps);
    expect(res).toMatchObject({ outcome: 'refused', restartScheduled: false });
    expect(await repo.list()).toEqual([]);
    expect(scheduleProcessExit).not.toHaveBeenCalled();
    // The grant is the live principal mailbox's: never revoked.
    expect(deleteGrant).not.toHaveBeenCalled();
    expectOneFinished('refused');
  });

  it('a principal add refusal is refused and the unused grant is revoked', async () => {
    // The address is one of Curia's own accounts, but its grant differs: admin.add refuses it.
    await repo.create({ name: 'curia', selfEmail: 'boss@example.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-other-0010');
    nylasGrant('code-1', 'grant-boss-0011', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('refused');
    expect(deleteGrant).toHaveBeenCalledWith('grant-boss-0011');
    expect(logLines.some((l) => l['refusal'] === 'curia_account_address')).toBe(true);
    expectOneFinished('refused');
  });

  it('an unexpected throw after the token is spent is failed, published, and never thrown', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    deps = { ...deps, principalStore: { ...store, listLive: async () => { throw new Error('db down'); }, hasAnyRow: () => store.hasAnyRow(), getAny: (id: string) => store.getAny(id) } };
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    expectOneFinished('failed');
  });
});
