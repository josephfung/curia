// Google Workspace sign-in (#2683): the pure helpers and the live status check. The state and
// callback paths run against real Postgres in tests/integration/google-workspace-signin.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSilentLogger } from '../../../src/logger.js';
import {
  GOOGLE_TOKEN_URL,
  GoogleWorkspaceSignInService,
  WORKSPACE_REQUIRED_SCOPES,
  WORKSPACE_STATUS_CACHE_MS,
  WorkspaceCheckUnavailableError,
  idTokenClaims,
  missingWorkspaceScopes,
  workspaceCallbackUrl,
  type WorkspaceSettings,
} from '../../../src/google/workspace-signin.js';
import {
  quoteEmailForFilename,
  workspaceCredentialPath,
  writeWorkspaceToken,
  type WorkspaceTokenFile,
} from '../../../src/google/workspace-token-file.js';

const SETTINGS: WorkspaceSettings = { email: 'curia@example.com', clientId: 'client-1', clientSecret: 'secret-1' };
const SCOPES = [...WORKSPACE_REQUIRED_SCOPES];

describe('quoteEmailForFilename (workspace-mcp’s quote(email, safe="@._-"))', () => {
  it.each([
    ['curia@example.com', 'curia@example.com'],
    ['curia+docs@example.com', 'curia%2Bdocs@example.com'],
    ['a.b_c-d~e@x.io', 'a.b_c-d~e@x.io'],
    ['../evil@x.com', '..%2Fevil@x.com'],
    ['café@x.com', 'caf%C3%A9@x.com'],
  ])('%s → %s', (email, file) => {
    expect(quoteEmailForFilename(email)).toBe(file);
  });

  it('keeps every file inside the credentials directory', () => {
    expect(workspaceCredentialPath('../../etc/passwd@x', '/home/curia')).toBe('/home/curia/.google_workspace_mcp/credentials/..%2F..%2Fetc%2Fpasswd@x.json');
  });
});

describe('workspaceCallbackUrl', () => {
  it.each([
    ['https://curia.example.com', 'https://curia.example.com/api/google-workspace/callback'],
    ['https://curia.example.com/', 'https://curia.example.com/api/google-workspace/callback'],
    ['http://localhost:3000', 'http://localhost:3000/api/google-workspace/callback'],
    ['http://curia.example.com', null],
    ['not a url', null],
    [undefined, null],
  ])('%s → %s', (origin, url) => {
    expect(workspaceCallbackUrl(origin)).toBe(url);
  });
});

describe('missingWorkspaceScopes', () => {
  it('needs Drive, Docs and Sheets in full', () => {
    expect(missingWorkspaceScopes(SCOPES.join(' '))).toEqual([]);
    expect(missingWorkspaceScopes('https://www.googleapis.com/auth/drive.readonly')).toEqual(SCOPES);
    expect(missingWorkspaceScopes(undefined)).toEqual(SCOPES);
  });
});

describe('idTokenClaims', () => {
  const token = (c: object) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
  it('reads the address lowercased, whether it is verified, and the audience', () => {
    expect(idTokenClaims(token({ email: 'Curia@Example.com', email_verified: true, aud: 'c' })))
      .toEqual({ email: 'curia@example.com', emailVerified: true, aud: 'c' });
  });
  it('names no one for a missing or malformed token', () => {
    expect(idTokenClaims(undefined).email).toBeNull();
    expect(idTokenClaims('a.%%%.b').email).toBeNull();
    expect(idTokenClaims(token({ email: 'x@y.z' })).emailVerified).toBe(false);
  });
});

describe('GoogleWorkspaceSignInService.status', () => {
  let home: string;
  let now: number;
  let refreshes: number;
  let answer: () => Response;

  const pool = { query: async () => { throw new Error('status never touches the database'); } };

  function service(settings: WorkspaceSettings = SETTINGS): GoogleWorkspaceSignInService {
    return new GoogleWorkspaceSignInService({
      pool: pool as never,
      logger: createSilentLogger(),
      appOrigin: 'https://curia.example.com',
      readSettings: async () => settings,
      home,
      now: () => now,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(GOOGLE_TOKEN_URL);
        expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('refresh_token');
        refreshes++;
        return answer();
      }) as typeof fetch,
    });
  }

  const saved: WorkspaceTokenFile = {
    token: 'old', refresh_token: 'fake-refresh', token_uri: GOOGLE_TOKEN_URL, client_id: 'client-1', client_secret: 'secret-1', scopes: SCOPES, expiry: null,
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'curia-gws-status-'));
    now = 1_000_000;
    refreshes = 0;
    answer = () => new Response(JSON.stringify({ access_token: 'new', scope: SCOPES.join(' ') }), { status: 200 });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('not_configured, naming each missing setting, without asking Google', async () => {
    expect(await service({ email: '', clientId: 'c', clientSecret: null }).status())
      .toEqual({ state: 'not_configured', missing: ['Curia’s Google address', 'the OAuth client secret'] });
    expect(refreshes).toBe(0);
  });

  it('not_signed_in when there is no token file', async () => {
    expect(await service().status()).toEqual({ state: 'not_signed_in' });
    expect(refreshes).toBe(0);
  });

  it('signed_in for a token Google refreshes, such as one copied by hand before #2683', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    expect(await service().status()).toEqual({ state: 'signed_in' });
  });

  it('token_rejected when Google refuses the refresh token', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    answer = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    expect(await service().status()).toMatchObject({ state: 'token_rejected', detail: expect.stringMatching(/Sign in as Curia again/) });
  });

  it('token_rejected for any other 400/401 Google refusal, naming the code', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    answer = () => new Response(JSON.stringify({ error: 'deleted_client' }), { status: 401 });
    expect(await service().status()).toMatchObject({ state: 'token_rejected', detail: expect.stringMatching(/deleted_client/) });
  });

  it('token_rejected, not "try again", for a damaged token file', async () => {
    const file = workspaceCredentialPath('curia@example.com', home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    expect(await service().status()).toMatchObject({ state: 'token_rejected', detail: expect.stringMatching(/can’t read/) });
    expect(refreshes).toBe(0);
  });

  it('token_rejected when the grant lacks a scope', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    answer = () => new Response(JSON.stringify({ access_token: 'n', scope: SCOPES[0] }), { status: 200 });
    expect((await service().status()).state).toBe('token_rejected');
  });

  it('adds the MCP server switch to signed_in, read fresh even from the cache', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    let enabled = false;
    const s = new GoogleWorkspaceSignInService({
      pool: pool as never, logger: createSilentLogger(), appOrigin: 'https://curia.example.com',
      readSettings: async () => SETTINGS, home, now: () => now,
      fetchImpl: (async () => { refreshes++; return answer(); }) as typeof fetch,
      mcpServer: { isEnabled: async () => enabled, enable: async () => { enabled = true; } },
    });
    expect(await s.status()).toEqual({ state: 'signed_in', serverEnabled: false });
    enabled = true;
    expect(await s.status()).toEqual({ state: 'signed_in', serverEnabled: true });
    expect(refreshes).toBe(1);
  });

  it('throws, rather than guessing, when Google does not answer', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    answer = () => new Response('oops', { status: 503 });
    await expect(service().status()).rejects.toThrow(WorkspaceCheckUnavailableError);
  });

  it('reuses a result until the cache lapses or the token file changes', async () => {
    await writeWorkspaceToken('curia@example.com', saved, home);
    const s = service();
    await s.status();
    await s.status();
    expect(refreshes).toBe(1);
    now += WORKSPACE_STATUS_CACHE_MS + 1;
    await s.status();
    expect(refreshes).toBe(2);
    // A new sign-in rewrites the file: the next check asks again.
    const file = workspaceCredentialPath('curia@example.com', home);
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    await s.status();
    expect(refreshes).toBe(3);
  });
});
