// Integration test — "Sign in as Curia" for Google Workspace against real Postgres (#2683).
// Google's token endpoint is a stub; the token file goes to a temp HOME. Skips without
// DATABASE_URL. Rows are keyed by the hash of states minted here; cleanup removes only those.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { hashToken } from '../../src/channels/http/session-auth.js';
import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleWorkspaceSignInService,
  WORKSPACE_REQUIRED_SCOPES,
  WorkspaceSignInUnavailableError,
  type WorkspaceSettings,
} from '../../src/google/workspace-signin.js';
import { readWorkspaceToken } from '../../src/google/workspace-token-file.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });
const ORIGIN = 'https://curia.example.com';
const SETTINGS: WorkspaceSettings = { email: 'Curia@Example.com', clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' };
const ALL_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...WORKSPACE_REQUIRED_SCOPES].join(' ');

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
}

interface Exchange { email?: string; aud?: string; scope?: string; refresh?: boolean; status?: number }

describeIf('GoogleWorkspaceSignInService', () => {
  let pool: pg.Pool;
  let databaseValidated = false;
  let home: string;
  const hashes: string[] = [];
  let calls: Array<{ url: string; body: URLSearchParams }> = [];
  let restarts: number[] = [];

  function fakeFetch(exchange: Exchange): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
      if (url === GOOGLE_REVOKE_URL) return new Response('', { status: 200 });
      if (exchange.status && exchange.status !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: exchange.status });
      }
      return new Response(JSON.stringify({
        access_token: 'ya29.access',
        ...(exchange.refresh === false ? {} : { refresh_token: '1//refresh' }),
        expires_in: 3599,
        scope: exchange.scope ?? ALL_SCOPES,
        id_token: idToken({ email: exchange.email ?? 'curia@example.com', email_verified: true, aud: exchange.aud ?? SETTINGS.clientId }),
      }), { status: 200 });
    }) as typeof fetch;
  }

  function makeService(exchange: Exchange = {}, over: { settings?: WorkspaceSettings; appOrigin?: string } = {}): GoogleWorkspaceSignInService {
    return new GoogleWorkspaceSignInService({
      pool,
      logger,
      appOrigin: 'appOrigin' in over ? over.appOrigin : ORIGIN,
      readSettings: async () => over.settings ?? SETTINGS,
      scheduleRestart: (ms) => { restarts.push(ms); },
      fetchImpl: fakeFetch(exchange),
      home,
    });
  }

  /** start() and remember the state's hash for cleanup. */
  async function begin(service: GoogleWorkspaceSignInService): Promise<{ state: string; url: URL }> {
    const { url } = await service.start();
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state')!;
    hashes.push(hashToken(state));
    return { state, url: parsed };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    databaseValidated = true;
  });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'curia-gws-'));
    calls = [];
    restarts = [];
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    if (databaseValidated && hashes.length > 0) {
      await pool.query('DELETE FROM google_workspace_signin_states WHERE state_hash = ANY($1)', [hashes]);
      hashes.length = 0;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('builds a consent URL for the saved account, with PKCE, offline access and only the needed scopes', async () => {
    const { url, state } = await begin(makeService());
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(SETTINGS.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/google-workspace/callback`);
    expect(url.searchParams.get('login_hint')).toBe(SETTINGS.email);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining([...WORKSPACE_REQUIRED_SCOPES]));
    expect(url.searchParams.get('scope')).not.toMatch(/calendar|gmail|presentations/);
    // Only the hash is stored.
    const rows = await pool.query('SELECT state_hash FROM google_workspace_signin_states WHERE state_hash = $1', [hashToken(state)]);
    expect(rows.rowCount).toBe(1);
  });

  it('refuses to start without the three settings, naming what is missing', async () => {
    await expect(makeService({}, { settings: { email: null, clientId: 'x', clientSecret: null } }).start())
      .rejects.toThrow(WorkspaceSignInUnavailableError);
    await expect(makeService({}, { settings: { email: null, clientId: 'x', clientSecret: null } }).start())
      .rejects.toThrow(/Google address, the OAuth client secret/);
  });

  it('refuses to start without a usable APP_ORIGIN', async () => {
    await expect(makeService({}, { appOrigin: 'http://curia.example.com' }).start()).rejects.toMatchObject({ reason: 'origin_unusable' });
  });

  it('signs in: exchanges the code with the verifier, writes the token file, schedules the restart', async () => {
    const service = makeService();
    const { state } = await begin(service);
    const result = await service.handleCallback({ state, code: 'auth-code' });
    expect(result).toEqual({ outcome: 'signed_in', restartScheduled: true });
    expect(restarts).toHaveLength(1);

    const exchange = calls.find((c) => c.url === GOOGLE_TOKEN_URL)!;
    expect(exchange.body.get('grant_type')).toBe('authorization_code');
    expect(exchange.body.get('code')).toBe('auth-code');
    expect(exchange.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange.body.get('redirect_uri')).toBe(`${ORIGIN}/api/google-workspace/callback`);

    const token = await readWorkspaceToken('curia@example.com', home);
    expect(token).toMatchObject({
      token: 'ya29.access',
      refresh_token: '1//refresh',
      token_uri: GOOGLE_TOKEN_URL,
      client_id: SETTINGS.clientId,
      client_secret: SETTINGS.clientSecret,
    });
    expect(token!.scopes).toEqual(expect.arrayContaining([...WORKSPACE_REQUIRED_SCOPES]));
    expect(token!.expiry).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    const stat = await fs.stat(path.join(home, '.google_workspace_mcp', 'credentials', 'curia@example.com.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('spends the state once: a second callback with it reads used and exchanges nothing', async () => {
    const service = makeService();
    const { state } = await begin(service);
    await service.handleCallback({ state, code: 'auth-code' });
    calls = [];
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('used');
    expect(calls).toHaveLength(0);
  });

  it('refuses a lapsed state as expired and spends it', async () => {
    const service = makeService();
    const { state } = await begin(service);
    await pool.query(`UPDATE google_workspace_signin_states SET expires_at = now() - interval '1 minute' WHERE state_hash = $1`, [hashToken(state)]);
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('expired');
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('used');
    expect(calls).toHaveLength(0);
  });

  it('refuses an unknown or missing state', async () => {
    const service = makeService();
    expect((await service.handleCallback({ state: 'never-minted', code: 'c' })).outcome).toBe('not_found');
    expect((await service.handleCallback({ code: 'c' })).outcome).toBe('not_found');
  });

  it('reads a declined consent as cancelled, and spends the state', async () => {
    const service = makeService();
    const { state } = await begin(service);
    expect((await service.handleCallback({ state, error: 'access_denied' })).outcome).toBe('cancelled');
    expect((await service.handleCallback({ state, code: 'c' })).outcome).toBe('used');
  });

  it('refuses a different Google account, revokes its grant, and writes nothing', async () => {
    const service = makeService({ email: 'someone.else@example.com' });
    const { state } = await begin(service);
    expect(await service.handleCallback({ state, code: 'auth-code' })).toEqual({ outcome: 'wrong_account', restartScheduled: false });
    expect(calls.some((c) => c.url === GOOGLE_REVOKE_URL)).toBe(true);
    expect(await readWorkspaceToken('curia@example.com', home)).toBeNull();
    expect(restarts).toHaveLength(0);
  });

  it('refuses a sign-in missing a scope, distinctly from a wrong account', async () => {
    const service = makeService({ scope: `openid ${WORKSPACE_REQUIRED_SCOPES[0]} ${WORKSPACE_REQUIRED_SCOPES[1]}` });
    const { state } = await begin(service);
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('missing_scopes');
    expect(calls.some((c) => c.url === GOOGLE_REVOKE_URL)).toBe(true);
    expect(await readWorkspaceToken('curia@example.com', home)).toBeNull();
  });

  it('refuses an ID token issued to another client', async () => {
    const service = makeService({ aud: 'other-client' });
    const { state } = await begin(service);
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('failed');
    expect(await readWorkspaceToken('curia@example.com', home)).toBeNull();
  });

  it('fails when Google rejects the code, and when no refresh token comes back', async () => {
    const rejected = makeService({ status: 400 });
    const a = await begin(rejected);
    expect((await rejected.handleCallback({ state: a.state, code: 'bad' })).outcome).toBe('failed');

    const noRefresh = makeService({ refresh: false });
    const b = await begin(noRefresh);
    expect((await noRefresh.handleCallback({ state: b.state, code: 'auth-code' })).outcome).toBe('failed');
    expect(await readWorkspaceToken('curia@example.com', home)).toBeNull();
  });

  it('reads not_ready when the settings were removed between start and callback', async () => {
    let settings: WorkspaceSettings = SETTINGS;
    const service = new GoogleWorkspaceSignInService({
      pool, logger, appOrigin: ORIGIN, home, readSettings: async () => settings, fetchImpl: fakeFetch({}),
    });
    const { state } = await begin(service);
    settings = { ...SETTINGS, clientSecret: null };
    expect((await service.handleCallback({ state, code: 'auth-code' })).outcome).toBe('not_ready');
  });
});
