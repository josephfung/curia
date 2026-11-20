// workspace-token-file.ts — the token cache the google-workspace MCP server (workspace-mcp)
// reads, at the path and in the shape it uses itself (#2683).
//
// workspace-mcp keeps one JSON file per Google account under
// ~/.google_workspace_mcp/credentials/, named by the address URL-encoded with Python's
// quote(email, safe="@._-"). The MCP subprocess inherits Curia's HOME (mcp-loader passes HOME
// through), so Curia writes to the same place. The server reads the file on each tool call
// (checked against 2.0.1), so a first sign-in is picked up without a restart.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** The fields workspace-mcp's LocalDirectoryCredentialStore writes and reads. */
export interface WorkspaceTokenFile {
  token: string | null;
  refresh_token: string | null;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  /** Naive ISO timestamp (UTC, no offset), as google-auth's Credentials.expiry serialises. */
  expiry: string | null;
}

export function workspaceCredentialsDir(home: string = os.homedir()): string {
  return path.join(home, '.google_workspace_mcp', 'credentials');
}

/**
 * Python's urllib.parse.quote(email, safe="@._-"): letters, digits, `_.-~` and `@` stay as they
 * are, every other UTF-8 byte becomes %XX. `curia+docs@x.com` → `curia%2Bdocs@x.com`.
 */
export function quoteEmailForFilename(email: string): string {
  let out = '';
  for (const byte of Buffer.from(email, 'utf-8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~@]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function workspaceCredentialPath(email: string, home: string = os.homedir()): string {
  return path.join(workspaceCredentialsDir(home), `${quoteEmailForFilename(email)}.json`);
}

/** The saved token for this address, or null when there is none. Throws on an unreadable file. */
export async function readWorkspaceToken(email: string, home?: string): Promise<WorkspaceTokenFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(workspaceCredentialPath(email, home), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as WorkspaceTokenFile;
}

/**
 * Write the token where workspace-mcp reads it: owner-only (0700 dir, 0600 file, as the server
 * creates them), through a temp file and a rename so the server never reads half a file.
 */
export async function writeWorkspaceToken(email: string, token: WorkspaceTokenFile, home?: string): Promise<void> {
  const dir = workspaceCredentialsDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = workspaceCredentialPath(email, home);
  const tmp = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
