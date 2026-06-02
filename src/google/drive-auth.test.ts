import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getDriveClient, clearDriveClientCache } from './drive-auth.js';

// Prevent real OAuth2 construction — we only test token loading logic.
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(function (clientId: string, clientSecret: string) {
        return {
          clientId,
          clientSecret,
          setCredentials: vi.fn(),
        };
      }),
    },
  },
}));

let tmpDir: string;
let tokenCachePath: string;

const validTokenJson = JSON.stringify({
  refresh_token: 'test-refresh-token',
  token: 'test-access-token',
  token_uri: 'https://oauth2.googleapis.com/token',
});

beforeEach(async () => {
  clearDriveClientCache();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
  process.env.CURIA_GOOGLE_EMAIL = 'curia@test.com';
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-auth-test-'));
  tokenCachePath = path.join(tmpDir, 'tokens.json');
});

afterEach(async () => {
  clearDriveClientCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.CURIA_GOOGLE_EMAIL;
});

describe('getDriveClient — env var validation', () => {
  it('throws when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('throws when GOOGLE_OAUTH_CLIENT_SECRET is missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('GOOGLE_OAUTH_CLIENT_SECRET');
  });

  it('throws when CURIA_GOOGLE_EMAIL is missing', async () => {
    delete process.env.CURIA_GOOGLE_EMAIL;
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('CURIA_GOOGLE_EMAIL');
  });
});

describe('getDriveClient — token cache', () => {
  it('throws with setup instructions when cache file is missing', async () => {
    const err = await getDriveClient({ tokenCachePath: '/nonexistent/path.json' }).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('token cache not found');
    expect(err.message).toContain('docs/dev/google-drive.md');
  });

  it('throws when refresh_token is absent from cache', async () => {
    await fs.writeFile(tokenCachePath, JSON.stringify({ token: 'access-only' }));
    await expect(getDriveClient({ tokenCachePath })).rejects.toThrow('missing refresh_token');
  });

  it('returns an OAuth2Client with setCredentials called on success', async () => {
    await fs.writeFile(tokenCachePath, validTokenJson);
    const client = await getDriveClient({ tokenCachePath });
    expect(client).toBeDefined();
    expect((client as unknown as { setCredentials: ReturnType<typeof vi.fn> }).setCredentials)
      .toHaveBeenCalledWith({ refresh_token: 'test-refresh-token' });
  });

  it('returns cached client on subsequent calls (reads file only once)', async () => {
    await fs.writeFile(tokenCachePath, validTokenJson);
    const a = await getDriveClient({ tokenCachePath });
    const b = await getDriveClient({ tokenCachePath });
    expect(a).toBe(b);
  });
});
