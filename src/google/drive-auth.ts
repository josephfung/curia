import fs from 'node:fs/promises';
import { google } from 'googleapis';
import { workspaceCredentialPath } from './workspace-token-file.js';

// One cached client per token file, so multiple identities in the same process each get
// their own (and tests with different paths stay isolated). The entry also records the client
// ID and secret it was built with: a credential rotated in the vault (no restart) replaces it
// instead of refreshing with the old secret (#2697 review). A new sign-in restarts Curia, so a
// rewritten token file never meets a cached client.
const clientCache = new Map<
  string,
  { clientId: string; clientSecret: string; client: InstanceType<typeof google.auth.OAuth2> }
>();

export interface DriveAuthOptions {
  tokenCachePath?: string;
  clientId?: string;
  clientSecret?: string;
  /** Used to locate the token cache file, not passed to OAuth. */
  email?: string;
}

export async function getDriveClient(
  options?: DriveAuthOptions,
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const clientId = options?.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = options?.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const email = options?.email ?? process.env.CURIA_GOOGLE_EMAIL;

  if (!clientId) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set');
  if (!clientSecret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not set');
  if (!email) throw new Error('CURIA_GOOGLE_EMAIL is not set');

  // workspace-mcp's own file name: the address URL-encoded (curia+docs@ → curia%2Bdocs@).
  const tokenCachePath = options?.tokenCachePath ?? workspaceCredentialPath(email);

  const cached = clientCache.get(tokenCachePath);
  if (cached && cached.clientId === clientId && cached.clientSecret === clientSecret) return cached.client;

  let tokenData: Record<string, unknown>;
  try {
    const raw = await fs.readFile(tokenCachePath, 'utf-8');
    tokenData = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Google OAuth token cache not found at ${tokenCachePath}. ` +
          `Complete the Drive auth setup (docs/dev/google-drive.md).`,
      );
    }
    throw new Error(
      `Failed to read Google OAuth token cache at ${tokenCachePath}: ${String(err)}`,
    );
  }

  const refreshToken =
    typeof tokenData['refresh_token'] === 'string' ? tokenData['refresh_token'] : undefined;
  if (!refreshToken) {
    throw new Error(
      `Google OAuth token cache at ${tokenCachePath} is missing refresh_token. Re-run the OAuth flow.`,
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  clientCache.set(tokenCachePath, { clientId, clientSecret, client: auth });
  return auth;
}

/** Reset the cached clients. For tests only. */
export function clearDriveClientCache(): void {
  clientCache.clear();
}
