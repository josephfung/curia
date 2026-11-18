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
import { FLAT_EMAIL_KEY, FLAT_GRANT_KEY, principalMailboxGrantSecretName } from '../../src/principal-mailboxes/secrets.js';
import { EmailAccountsRepo } from '../../src/channels/email/email-accounts-repo.js';
import { emailAccountGrantSecretName } from '../../src/channels/email/email-account-secrets.js';
import { NylasAppError, type NylasAppClient, type NylasGrantInfo } from '../../src/nylas/app-client.js';
import {
  MAILBOX_SIGNIN_SCOPES,
  NYLAS_API_KEY_SECRET,
  NYLAS_REGION_SECRET,
  createNylasSignInReaders,
  type NylasSignInReadiness,
} from '../../src/nylas/signin-readiness.js';
import { createLiveGrantLookup } from '../../src/nylas/live-grant-lookup.js';
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
  /** Nylas's created_at per grant id; an entry set to undefined reads as an undated grant. */
  let createdAt: Map<string, Date | undefined>;
  let codes: Map<string, string>;
  let published: BusEvent[];
  /** Event types published through publishDetached, and the order of publishes and the restart. */
  let detached: string[];
  let sequence: string[];
  let logLines: Array<Record<string, unknown>>;
  let rawLog: string[];
  let exchangeCode: Mock<NylasAppClient['exchangeCode']>;
  let deleteGrant: Mock<NylasAppClient['deleteGrant']>;
  let getApplication: Mock<NylasAppClient['getApplication']>;
  let scheduleRestart: Mock<(delayMs: number) => void>;
  let secretsSet: Mock<(name: string, value: string) => Promise<void>>;
  /** Every (key, base URL) the admin's grant lookup used. */
  let lookups: Array<{ apiKey: string; apiUri: string }>;
  let linkIdentity: Mock<(input: Record<string, unknown>) => Promise<{ id: string }>>;
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
    createdAt = new Map();
    codes = new Map();
    published = [];
    detached = [];
    sequence = [];
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
    getApplication = vi.fn<NylasAppClient['getApplication']>(async () => ({
      applicationId: READY.ready ? READY.applicationId : '', region: 'us', environment: 'production', callbackUris: [],
    }));
    const getGrant = vi.fn(async (grantId: string) => {
      const g = grants.get(grantId);
      if (!g) throw new NylasAppError('Nylas get grant failed: HTTP 404', 404);
      // Undated grants are dated "now", after the link was minted: created by this sign-in. The
      // minute's margin keeps a host/DB clock difference from making it look older.
      return { ...g, createdAt: createdAt.has(grantId) ? createdAt.get(grantId) : new Date(Date.now() + 60_000) };
    });
    scheduleRestart = vi.fn<(delayMs: number) => void>(() => { sequence.push('restart'); });

    secretsSet = vi.fn<(name: string, value: string) => Promise<void>>(async (name, value) => { vault.set(name, value); });
    const secrets = {
      get: async (name: string) => vault.get(name) ?? null,
      set: secretsSet,
      delete: async (name: string) => { vault.delete(name); },
    };
    store = new PrincipalMailboxStore(pool, logger);
    repo = new EmailAccountsRepo(pool);
    linkIdentity = vi.fn(async () => ({ id: randomUUID() }));
    const contacts = {
      getContactWithIdentities: async () => ({ contact: { primaryEmail: 'boss@example.com' }, identities: [] }),
      linkIdentity,
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
      // Wired as src/index.ts wires it (R7): the key and region are read live from the vault.
      lookupGrant: createLiveGrantLookup({
        ...createNylasSignInReaders({ secrets, env: {}, logger }),
        lookup: async (apiKey, apiUri, grantId) => {
          lookups.push({ apiKey, apiUri });
          const g = grants.get(grantId);
          if (!g) throw new Error('no grant');
          return { email: g.email, provider: g.provider };
        },
      }),
      logger,
    });
    // Saved after the admin was built, as when the operator saves the key in the console after boot.
    lookups = [];
    vault.set(NYLAS_API_KEY_SECRET, 'nyk_saved_after_boot');

    deps = {
      signIn: new MailboxSignInService({ pool, logger, appOrigin: ORIGIN, readiness: async () => READY }),
      readApiKey: async () => 'nyk_test_key',
      readRegion: async () => 'us',
      boot: { apiKey: 'nyk_test_key', region: 'us' },
      appOrigin: ORIGIN,
      // No listConnectors: the callback needs only the application id (L).
      makeClient: () => ({ exchangeCode, getGrant, deleteGrant, getApplication }),
      principalStore: store,
      principalAdmin,
      emailAccounts: repo,
      secrets,
      bus: {
        publish: async (_layer, event) => { published.push(event); sequence.push(event.type); },
        publishDetached: async (_layer, event) => { published.push(event); detached.push(event.type); sequence.push(event.type); },
      },
      scheduleRestart,
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

  /** Vault entries other than the Nylas key itself. */
  const storedGrants = () => [...vault.keys()].filter((k) => k !== NYLAS_API_KEY_SECRET && k !== NYLAS_REGION_SECRET);
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
    expect(finished()[0]!.payload).not.toHaveProperty('restartScheduled');
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

  it('a link pinned to a brand-new address, signed in with that account, connects and links the identity', async () => {
    nylasGrant('code-new', 'grant-new-0001', 'New.Job@Acme.com');
    const mint = new MailboxSignInService({
      pool, logger: pino({ level: 'silent' }), appOrigin: ORIGIN, readiness: async () => READY,
      principalEmails: () => ({ primary: 'boss@example.com', all: ['boss@example.com'] }),
    });
    const { url } = await mint.mint({ target: 'principal', mailboxAddress: ' New.Job@Acme.com ', allowNewAddress: true });
    const state = url.slice(url.lastIndexOf('/') + 1);
    const res = await handleMailboxSignInCallback({ state, code: 'code-new' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', target: 'principal' });
    expect((await store.listLive()).map((m) => m.address)).toEqual(['new.job@acme.com']);
    expect(linkIdentity).toHaveBeenCalledTimes(1);
    expect(linkIdentity).toHaveBeenCalledWith({
      contactId: 'ceo', channel: 'email', channelIdentifier: 'new.job@acme.com', source: 'ceo_stated', verified: true,
    });
  });

  it('uses a Nylas key that reached the vault only after the admin was built (R7)', async () => {
    vault.set(NYLAS_REGION_SECRET, 'eu');
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('connected');
    expect(lookups).toEqual([{ apiKey: 'nyk_saved_after_boot', apiUri: 'https://api.eu.nylas.com' }]);
  });

  it('with no key in the vault or env, the add is refused and nothing is stored (R7)', async () => {
    vault.delete(NYLAS_API_KEY_SECRET);
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('refused');
    expect(lookups).toEqual([]);
    expect(logLines.some((l) => l['refusal'] === 'grant_unreadable')).toBe(true);
    expect(await store.listLive()).toEqual([]);
  });

  it('a failed vault read of the key fails the sign-in without exchanging the code with the env key', async () => {
    const readers = createNylasSignInReaders({
      secrets: { get: async () => { throw new Error('vault down'); } },
      env: { NYLAS_API_KEY: 'nyk_test_key' },
      logger: deps.logger,
    });
    deps = { ...deps, ...readers };
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(logLines.some((l) => l['reason'] === 'settings_unreadable')).toBe(true);
    expect(rawLog.join('\n')).not.toContain('nyk_test_key');
    expect(await store.listLive()).toEqual([]);
    expectOneFinished('failed');
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
    // The replaced grant is held by nothing now: revoked.
    expect(deleteGrant.mock.calls).toEqual([['grant-boss-0001']]);
    expectOneFinished('reconnected');
    expectNoGrantInLogs();
  });

  it('a replaced principal grant still held elsewhere is NOT revoked', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    // The same id also sits under a Curia account (the used-anywhere scan must find it).
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-boss-0001');
    nylasGrant('code-2', 'grant-boss-0099', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-2' }, deps);
    expect(res.outcome).toBe('reconnected');
    expect(deleteGrant).not.toHaveBeenCalled();
  });

  it('wrong account: the stray grant is revoked and nothing is stored', async () => {
    nylasGrant('code-1', 'grant-stray-0003', 'someone@else.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).toHaveBeenCalledTimes(1);
    expect(deleteGrant).toHaveBeenCalledWith('grant-stray-0003');
    expect(await store.listLive()).toEqual([]);
    expect(storedGrants()).toEqual([]);
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
    // Spent: a replay of the same state reads used and publishes nothing more (K).
    published = [];
    expect((await handleMailboxSignInCallback({ state, code: 'code-1' }, deps)).outcome).toBe('used');
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
    expect(storedGrants()).toEqual([]);
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
    expect(storedGrants()).toEqual([]);
    expect(deleteGrant).not.toHaveBeenCalled();
    const warn = logLines.find((l) => l['level'] === 40 && l['step'] === 'exchange');
    expect(warn).toMatchObject({ errName: 'NylasAppError', statusCode: 400 });
    expect(rawLog.join('\n')).not.toContain('code-SECRET-unknown');
    expectOneFinished('failed');
  });

  it('a replay of a link that already connected is used: no exchange, no event (K)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const state = await token();
    expect((await handleMailboxSignInCallback({ state, code: 'code-1' }, deps)).outcome).toBe('connected');
    published = [];
    exchangeCode.mockClear();
    const res = await handleMailboxSignInCallback({ state, code: 'code-1' }, deps);
    expect(res).toEqual({ outcome: 'used', restartScheduled: false });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('an unknown state is failed, exchanges nothing and publishes nothing', async () => {
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
    expect(scheduleRestart).toHaveBeenCalledWith(3000);
    let rows = await repo.list();
    expect(rows).toHaveLength(1);
    // No account delivers notifications until one is named 'curia', so the first one takes it.
    expect(rows[0]).toMatchObject({ name: 'curia', selfEmail: 'assistant@office.com', enabled: true });
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0006');
    expect(expectOneFinished('connected')).toMatchObject({ target: 'curia', restartScheduled: true });
    expect(await store.listLive()).toEqual([]);
    // The vault write is audited by key name, attributed to the sign-in link, never the value.
    expect(ofType('secret.changed').map((e) => e.payload)).toEqual([
      { secretName: 'channel.email.curia.nylas_grant_id', action: 'set', stage: 'requested', initiatedBy: 'signin_callback' },
      { secretName: 'channel.email.curia.nylas_grant_id', action: 'set', stage: 'completed', initiatedBy: 'signin_callback' },
    ]);

    published = [];
    await repo.update('curia', { enabled: false });
    nylasGrant('code-2', 'grant-curia-0007', 'assistant@office.com');
    // An operator link: an agent-minted one is refused once Curia has an account (R8).
    const again = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null, origin: false }), code: 'code-2' }, deps);
    expect(again).toMatchObject({ outcome: 'reconnected', restartScheduled: true });
    rows = await repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'curia', enabled: true });
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0007');
    expect(ofType('secret.changed').map((e) => (e.payload as { stage: string }).stage)).toEqual(['requested', 'completed']);
    // The grant it replaced is held by nothing now: revoked.
    expect(deleteGrant.mock.calls).toEqual([['grant-curia-0006']]);
    expectOneFinished('reconnected');
    expectNoGrantInLogs();
  });

  it('Curia re-auth returning the stored grant of an enabled account: no write, no audit, no restart', async () => {
    await repo.create({ name: 'curia', selfEmail: 'assistant@office.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-curia-0006');
    nylasGrant('code-1', 'grant-curia-0006', 'assistant@office.com');
    secretsSet.mockClear();
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null, origin: false }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'reconnected', restartScheduled: false });
    expect(secretsSet).not.toHaveBeenCalled();
    expect(ofType('secret.changed')).toHaveLength(0);
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(expectOneFinished('reconnected')).not.toHaveProperty('restartScheduled');
  });

  it('a replaced Curia grant still held elsewhere is NOT revoked', async () => {
    await repo.create({ name: 'curia', selfEmail: 'assistant@office.com' });
    await repo.create({ name: 'ops', selfEmail: 'ops@office.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-shared-0012');
    vault.set(emailAccountGrantSecretName('ops'), 'grant-shared-0012');
    nylasGrant('code-1', 'grant-curia-0013', 'assistant@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null, origin: false }), code: 'code-1' }, deps);
    expect(res.outcome).toBe('reconnected');
    expect(vault.get(emailAccountGrantSecretName('curia'))).toBe('grant-curia-0013');
    expect(deleteGrant).not.toHaveBeenCalled();
  });

  it('a Curia grant write that cannot be audited is not made, and the new account is removed', async () => {
    nylasGrant('code-1', 'grant-curia-0014', 'assistant@office.com');
    const publish = deps.bus.publish;
    deps = { ...deps, bus: { ...deps.bus, publish: async (layer, event) => {
      if (event.type === 'secret.changed') throw new Error('audit down');
      return publish(layer, event);
    } } };
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'failed', restartScheduled: false });
    expect(await repo.list()).toEqual([]);
    expect(storedGrants()).toEqual([]);
    expect(scheduleRestart).not.toHaveBeenCalled();
    // Stored nowhere, so the fresh grant is revoked.
    expect(deleteGrant).toHaveBeenCalledWith('grant-curia-0014');
    expectOneFinished('failed');
  });

  it("a second Curia address gets a slug of its local part, suffixed on collision", async () => {
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    await repo.create({ name: 'ops-desk', selfEmail: 'other@office.com' });
    nylasGrant('code-1', 'grant-ops-0008', 'Ops.Desk@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null, origin: false }), code: 'code-1' }, deps);
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
    expect(scheduleRestart).not.toHaveBeenCalled();
    // The grant is the live principal mailbox's: never revoked.
    expect(deleteGrant).not.toHaveBeenCalled();
    expectOneFinished('refused');
  });

  it('a principal add refusal is refused and the grant is kept (B: never revoke on refused)', async () => {
    // The address is one of Curia's own accounts, but its grant differs: admin.add refuses it.
    await repo.create({ name: 'curia', selfEmail: 'boss@example.com' });
    vault.set(emailAccountGrantSecretName('curia'), 'grant-other-0010');
    nylasGrant('code-1', 'grant-boss-0011', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('refused');
    // The account is the right one, so its grant is likely held somewhere: never revoked.
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(logLines.some((l) => l['refusal'] === 'curia_account_address')).toBe(true);
    expectOneFinished('refused');
  });

  it('an operator-pinned Curia link signed in with another account is wrong_account, nothing written (A, R8)', async () => {
    nylasGrant('code-1', 'grant-stray-0020', 'someone@else.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: 'assistant@office.com' }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'wrong_account', target: 'curia', restartScheduled: false });
    expect(await repo.list()).toEqual([]);
    expect(storedGrants()).toEqual([]);
    expect(scheduleRestart).not.toHaveBeenCalled();
    expectOneFinished('wrong_account');
  });

  it('a stray grant equal to the flat fallback grant is NOT revoked (B, R9)', async () => {
    vault.set(FLAT_GRANT_KEY, 'grant-flat-0021');
    nylasGrant('code-1', 'grant-flat-0021', 'someone@else.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(vault.get(FLAT_GRANT_KEY)).toBe('grant-flat-0021');
  });

  it('a Curia sign-in with the flat fallback address is refused, nothing written, grant kept (B, R9)', async () => {
    vault.set(FLAT_GRANT_KEY, 'grant-flat-0021');
    vault.set(FLAT_EMAIL_KEY, 'Boss@Example.com');
    nylasGrant('code-1', 'grant-flat-0021', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'refused', restartScheduled: false });
    expect(await repo.list()).toEqual([]);
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(deleteGrant).not.toHaveBeenCalled();
    expectOneFinished('refused');
  });

  it('a key saved after boot (restart_required) is failed with no exchange (D, L)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    deps = { ...deps, boot: { apiKey: undefined, region: 'us' } };
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(logLines.some((l) => l['reason'] === 'restart_required')).toBe(true);
    expectOneFinished('failed');
  });

  it('a region changed after boot is failed with no exchange (D, L)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    deps = { ...deps, readRegion: async () => 'eu' };
    expect((await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps)).outcome).toBe('failed');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('no key: failed with no exchange (L)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    deps = { ...deps, readApiKey: async () => undefined };
    expect((await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps)).outcome).toBe('failed');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('a failing application lookup is failed with no exchange, logged with its step (L, F)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    getApplication.mockRejectedValueOnce(new NylasAppError('Nylas get application failed: HTTP 503', 503));
    expect((await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps)).outcome).toBe('failed');
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(logLines.find((l) => l['step'] === 'lookup_application')).toMatchObject({ errName: 'NylasAppError', statusCode: 503 });
  });

  it('an unexpected throw after the token is spent is failed, published, and never thrown', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    deps = { ...deps, principalStore: { ...store, listLive: async () => { throw new Error('db down'); }, hasAnyRow: () => store.hasAnyRow(), getAny: (id: string) => store.getAny(id) } };
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    expectOneFinished('failed');
    // F: the catch-all names the step, and the message of an error that cannot carry a grant id.
    expect(logLines.find((l) => l['msg'] === 'mailbox sign-in callback failed unexpectedly')).toMatchObject({
      step: 'write_principal', errName: 'Error', errMessage: 'db down',
    });
  });

  it('a principal add that throws after it was requested logs the unknown outcome with its step (F)', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const failing = { add: async () => { throw new Error('vault write failed'); }, replaceGrant: async () => { throw new Error('unused'); } };
    deps = { ...deps, principalAdmin: failing };
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    // requested was published; completed was not, and the log says the outcome is unknown.
    expect(ofType('principal_mailbox.changed').map((e) => (e.payload as { stage: string }).stage)).toEqual(['requested']);
    expect(logLines.find((l) => l['level'] === 50 && l['action'] === 'add' && l['step'] === 'write_principal')).toMatchObject({
      errMessage: 'vault write failed', mailboxId: 'example',
    });
    expectNoGrantInLogs();
  });

  it('publishes mailbox_signin.finished detached, so the browser does not wait on the resumed turn', async () => {
    nylasGrant('code-1', 'grant-boss-0001', 'boss@example.com');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('connected');
    // Only the finished event: the registry audit rows stay awaited (a refused audit blocks the write).
    expect(detached).toEqual(['mailbox_signin.finished']);
    expectOneFinished('connected');
  });

  it('wrong account whose grant predates the link is NOT revoked: it may be another integration\'s', async () => {
    nylasGrant('code-1', 'grant-other-app-0030', 'someone@else.com');
    createdAt.set('grant-other-app-0030', new Date(Date.now() - 24 * 60 * 60_000));
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('wrong_account');
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(logLines.some((l) => l['msg'] === 'mailbox sign-in: the grant was not shown to be new; leaving it in Nylas')).toBe(true);
    expectOneFinished('wrong_account');
  });

  it('a grant Nylas does not date is NOT revoked (unknown ownership is kept)', async () => {
    nylasGrant('code-1', 'grant-undated-0031', 'boss@example.com', { provider: 'microsoft' });
    createdAt.set('grant-undated-0031', undefined);
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('not_google');
    expect(deleteGrant).not.toHaveBeenCalled();
  });

  it('a grant that could not be read is NOT revoked', async () => {
    codes.set('code-1', 'grant-unreadable-0032');
    const res = await handleMailboxSignInCallback({ state: await token(), code: 'code-1' }, deps);
    expect(res.outcome).toBe('failed');
    expect(deleteGrant).not.toHaveBeenCalled();
  });

  it('an agent-minted Curia link is refused once Curia has an account, before any exchange (R8)', async () => {
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    nylasGrant('code-1', 'grant-second-0033', 'second@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'refused', target: 'curia', restartScheduled: false });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect((await repo.list()).map((a) => a.name)).toEqual(['curia']);
    expect(storedGrants()).toEqual([]);
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(logLines.some((l) => l['reason'] === 'curia_mailbox_exists')).toBe(true);
    expectOneFinished('refused');
  });

  it('an operator-minted Curia link still adds a second account (R8 limits agents only)', async () => {
    await repo.create({ name: 'curia', selfEmail: 'curia@office.com' });
    nylasGrant('code-1', 'grant-second-0034', 'second@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null, origin: false }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', restartScheduled: true });
    expect((await repo.list())).toHaveLength(2);
  });

  it('an agent-minted Curia link is refused when the account list cannot be read (fail closed, R8)', async () => {
    nylasGrant('code-1', 'grant-curia-0035', 'assistant@office.com');
    deps = { ...deps, emailAccounts: { ...repo, list: async () => { throw new Error('db down'); },
      findBySelfEmail: (e: string) => repo.findBySelfEmail(e),
      createForAddress: (e: string, o: Parameters<EmailAccountsRepo['createForAddress']>[1]) => repo.createForAddress(e, o),
      update: (n: string, u: Parameters<EmailAccountsRepo['update']>[1]) => repo.update(n, u),
      delete: (n: string) => repo.delete(n) } };
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res.outcome).toBe('refused');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('the Curia restart is scheduled last, after the grant audit and the finished event', async () => {
    nylasGrant('code-1', 'grant-curia-0036', 'assistant@office.com');
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', restartScheduled: true });
    expect(sequence).toEqual(['secret.changed', 'secret.changed', 'mailbox_signin.finished', 'restart']);
  });

  it('a restart that cannot be scheduled is reported as not scheduled', async () => {
    nylasGrant('code-1', 'grant-curia-0037', 'assistant@office.com');
    scheduleRestart.mockImplementationOnce(() => { throw new Error('no timers'); });
    const res = await handleMailboxSignInCallback({ state: await token({ target: 'curia', expectedEmail: null }), code: 'code-1' }, deps);
    expect(res).toMatchObject({ outcome: 'connected', restartScheduled: false });
    expect(logLines.some((l) => l['level'] === 50 && String(l['msg']).includes('could not schedule the restart'))).toBe(true);
  });
});
