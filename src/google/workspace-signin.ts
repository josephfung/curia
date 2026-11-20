// workspace-signin.ts — "Sign in as Curia" for Google Workspace from the console (#2683).
//
// The console's authenticated button calls start(), which mints a single-use `state` (sha256 in
// google_workspace_signin_states, with a PKCE verifier) and returns Google's consent URL. Google
// sends the browser to the public callback with `state` and `code`; handleCallback() claims the
// state once, exchanges the code, checks the account is Curia's saved Google address and that
// Drive, Docs and Sheets were granted, then writes the token where the google-workspace MCP
// server reads it (workspace-token-file.ts), turns the google-workspace MCP server on in the
// registry (a new install enrols it off, since its keys did not exist at first boot), and
// schedules a graceful restart, as Curia's own mailbox sign-in does (#2681): it starts a server
// that was skipped at boot and drops any token the running one had cached for a stale sign-in.
//
// status() is the live check behind the Setup checklist's google_workspace step and the panel:
// it refreshes the saved token against Google, so an install signed in by hand reads done too.
//
// Never logged: the state, the code, the verifier, any token, the client secret.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { hashToken } from '../channels/http/session-auth.js';
import type { WorkspaceSignInOutcome } from './workspace-signin-outcome.js';
import {
  readWorkspaceToken,
  workspaceCredentialPath,
  writeWorkspaceToken,
  type WorkspaceTokenFile,
} from './workspace-token-file.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const DRIVE = 'https://www.googleapis.com/auth/drive';
const DOCS = 'https://www.googleapis.com/auth/documents';
const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * What the consent asks for: the services config/skills.yaml loads (`--tools drive docs sheets`,
 * #1957), plus the identity scopes that tell the callback which account signed in. The broad
 * scopes cover the read-only and drive.file ones workspace-mcp's tools declare (its
 * SCOPE_HIERARCHY), so this is the same grant scripts/gdrive-auth.py gets.
 */
export const WORKSPACE_SIGNIN_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  DRIVE,
  DOCS,
  SHEETS,
] as const;

/** A sign-in that lacks any of these is refused: Curia could not work in that service. */
export const WORKSPACE_REQUIRED_SCOPES = [DRIVE, DOCS, SHEETS] as const;

export const WORKSPACE_SECRET_KEYS = {
  email: 'curia_google_email',
  clientId: 'google_oauth_client_id',
  clientSecret: 'google_oauth_client_secret',
} as const;

/** How long a minted state is good for: long enough to read Google's screens, no longer. */
export const WORKSPACE_STATE_TTL_MINUTES = 15;
/** After a sign-in, the restart waits this long so the done page can render first. */
export const WORKSPACE_RESTART_DELAY_MS = 3000;
/** A definitive live check is reused this long, so the checklist does not ask Google on every poll. */
export const WORKSPACE_STATUS_CACHE_MS = 10 * 60_000;

export const WORKSPACE_CALLBACK_PATH = '/api/google-workspace/callback';

/** The MCP server this sign-in is for: config/skills.yaml's entry name. */
export const GOOGLE_WORKSPACE_MCP_SERVER = 'google-workspace';

export interface WorkspaceSettings {
  email: string | null;
  clientId: string | null;
  clientSecret: string | null;
}

/** The live sign-in check (the panel and setup-status's google_workspace step). */
export type WorkspaceSignInStatus =
  | { state: 'not_configured'; missing: string[] }
  | { state: 'not_signed_in' }
  | { state: 'token_rejected'; detail: string }
  // `serverEnabled: false`: the token works, but the google-workspace MCP server is off in the
  // registry, so Curia has no Workspace tools. Absent when the registry was not asked.
  | { state: 'signed_in'; serverEnabled?: boolean };

export type WorkspaceUnavailableReason = 'not_configured' | 'origin_unusable';

/** Thrown by start() when sign-in cannot begin. `detail` is operator-facing and holds no secret. */
export class WorkspaceSignInUnavailableError extends Error {
  constructor(readonly reason: WorkspaceUnavailableReason, readonly detail: string) {
    super(detail);
    this.name = 'WorkspaceSignInUnavailableError';
  }
}

/** Google could not be asked (network, 5xx): the check cannot say either way. */
export class WorkspaceCheckUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceCheckUnavailableError';
  }
}

export interface WorkspaceCallbackQuery {
  state?: string;
  code?: string;
  error?: string;
}

export interface WorkspaceCallbackResult {
  outcome: WorkspaceSignInOutcome;
  restartScheduled: boolean;
}

export interface WorkspaceSignInServiceDeps {
  pool: Pick<DbPool, 'query'>;
  logger: Logger;
  /** The console's public origin (APP_ORIGIN); the callback URL is built from it. */
  appOrigin: string | undefined;
  /** The three vault values, read live: the panel saves them without a restart. */
  readSettings: () => Promise<WorkspaceSettings>;
  /** Starts the graceful shutdown (SIGTERM) after the delay. Absent: no restart is scheduled. */
  scheduleRestart?: (delayMs: number) => void;
  /** The google-workspace MCP server's registry switch: read by status(), turned on by a sign-in.
   *  Absent: neither is done (tests, or a boot without the registry). */
  mcpServer?: {
    isEnabled: () => Promise<boolean>;
    enable: () => Promise<void>;
  };
  /** Test seams. */
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
}

/**
 * The origin Google will redirect back to. Google accepts https, and plain http only for
 * localhost, so anything else cannot be registered on the OAuth client.
 */
export function workspaceCallbackUrl(appOrigin: string | undefined): string | null {
  if (!appOrigin) return null;
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    // Not a URL at all: there is no callback to offer. Nothing to log per call; the panel says so.
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return `${url.origin}${WORKSPACE_CALLBACK_PATH}`;
}

/** The scopes in a space-separated `scope` string that this sign-in needs but lacks. */
export function missingWorkspaceScopes(scope: string | undefined): string[] {
  const granted = new Set((scope ?? '').split(/\s+/).filter((s) => s !== ''));
  return WORKSPACE_REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

/** The `email` and `aud` claims of an ID token. It came straight from Google's token endpoint
 *  over TLS, which OIDC Core §3.1.3.7 accepts in place of a signature check. */
export function idTokenClaims(idToken: string | undefined): { email: string | null; emailVerified: boolean; aud: string | null } {
  const payload = idToken?.split('.')[1];
  if (!payload) return { email: null, emailVerified: false, aud: null };
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
    return {
      email: typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : null,
      // Google sends a boolean; an absent claim is not proof.
      emailVerified: claims['email_verified'] === true || claims['email_verified'] === 'true',
      aud: typeof claims['aud'] === 'string' ? claims['aud'] : null,
    };
  } catch {
    // A malformed token names no one; the caller refuses the sign-in as failed and logs it.
    return { email: null, emailVerified: false, aud: null };
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
}

/** Errors on a refresh that mean the saved sign-in no longer works (as opposed to Google being down). */
const REJECTED_ERRORS: Record<string, string> = {
  invalid_grant: 'Google no longer accepts Curia’s saved sign-in (revoked, expired, or issued while the app was in Testing). Sign in as Curia again.',
  invalid_client: 'Google does not recognise the OAuth client this sign-in was made with. Check the client ID and secret, then sign in as Curia again.',
  unauthorized_client: 'The OAuth client is not allowed to refresh this sign-in. Check the client in Google Cloud, then sign in as Curia again.',
};

export class GoogleWorkspaceSignInService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private statusCache: { key: string; at: number; status: WorkspaceSignInStatus } | null = null;

  constructor(private readonly deps: WorkspaceSignInServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  callbackUrl(): string | null {
    return workspaceCallbackUrl(this.deps.appOrigin);
  }

  /** Mint a state and return Google's consent URL. Throws WorkspaceSignInUnavailableError. */
  async start(): Promise<{ url: string; expiresAt: Date }> {
    const settings = await this.deps.readSettings();
    const missing = missingSettings(settings);
    if (missing.length > 0) {
      throw new WorkspaceSignInUnavailableError('not_configured', `Save ${missing.join(', ')} first.`);
    }
    const redirectUri = this.callbackUrl();
    if (redirectUri === null) {
      throw new WorkspaceSignInUnavailableError('origin_unusable', 'Set APP_ORIGIN to this console’s public https:// address and restart Curia.');
    }

    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const res = await this.deps.pool.query<{ expires_at: Date }>(
      `INSERT INTO google_workspace_signin_states (state_hash, code_verifier, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))
       RETURNING expires_at`,
      [hashToken(state), verifier, WORKSPACE_STATE_TTL_MINUTES],
    );

    const params = new URLSearchParams({
      client_id: settings.clientId!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: WORKSPACE_SIGNIN_SCOPES.join(' '),
      // offline + consent: always return a refresh token, even for an account that consented before.
      access_type: 'offline',
      prompt: 'consent',
      login_hint: settings.email!,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    this.deps.logger.info('google workspace sign-in started');
    return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, expiresAt: res.rows[0]!.expires_at };
  }

  /** Google's redirect. Every Google-side path ends in an outcome; it throws only when the
   *  database or the vault cannot be read, which the route turns into `failed`. */
  async handleCallback(query: WorkspaceCallbackQuery): Promise<WorkspaceCallbackResult> {
    const log = this.deps.logger;
    const done = (outcome: WorkspaceSignInOutcome, restartScheduled = false): WorkspaceCallbackResult => {
      log.info({ outcome, restartScheduled }, 'google workspace sign-in finished');
      return { outcome, restartScheduled };
    };

    if (!query.state) return done('not_found');
    const claim = await this.claim(query.state);
    if (claim.status !== 'claimed') return done(claim.status);

    // The state is spent from here on: any refusal below needs a fresh click.
    if (query.error !== undefined) {
      // Google's error is a fixed code (admin_policy_enforced, invalid_scope, …), never a secret.
      if (query.error !== 'access_denied') log.warn({ googleError: query.error.slice(0, 64) }, 'google workspace sign-in: Google returned an error');
      return done(query.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    if (!query.code) return done('failed');

    const settings = await this.deps.readSettings();
    const redirectUri = this.callbackUrl();
    if (missingSettings(settings).length > 0 || redirectUri === null) return done('not_ready');
    // Compared lowercased (Google's address is), but the file is named by the address exactly as
    // saved: workspace-mcp gets that string as user_google_email and never lowercases it.
    const savedEmail = settings.email!.trim();
    const expected = savedEmail.toLowerCase();

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: redirectUri,
      client_id: settings.clientId!,
      client_secret: settings.clientSecret!,
      code_verifier: claim.verifier,
    });
    if (tokens.kind !== 'ok') {
      log.warn(tokens.kind === 'rejected' ? { status: tokens.status, error: tokens.error } : { unreachable: true }, 'google workspace sign-in: code exchange failed');
      return done('failed');
    }
    const body = tokens.body;

    const claims = idTokenClaims(body.id_token);
    if (claims.email === null || claims.aud !== settings.clientId) {
      log.warn({ hasEmail: claims.email !== null, audMatches: claims.aud === settings.clientId }, 'google workspace sign-in: ID token did not identify the account');
      return done('failed');
    }
    if (claims.email !== expected || !claims.emailVerified) {
      // Someone else's grant: revoke it so a stray sign-in leaves nothing live behind.
      log.warn({ emailVerified: claims.emailVerified }, 'google workspace sign-in refused: not Curia’s Google address');
      await this.revoke(body);
      return done('wrong_account');
    }
    const lacking = missingWorkspaceScopes(body.scope);
    if (lacking.length > 0) {
      // Curia's own account: no revoke. Google revokes the whole grant for the user and client,
      // which would also end the working sign-in the token file may already hold.
      log.warn({ missingScopes: lacking }, 'google workspace sign-in refused: scopes not granted');
      return done('missing_scopes');
    }
    if (!body.refresh_token || !body.access_token) {
      // prompt=consent always returns one; without it the MCP server would stop working within the hour.
      log.error({ hasRefreshToken: !!body.refresh_token, hasAccessToken: !!body.access_token }, 'google workspace sign-in: Google returned no refresh token');
      return done('failed');
    }

    const file: WorkspaceTokenFile = {
      token: body.access_token,
      refresh_token: body.refresh_token,
      token_uri: GOOGLE_TOKEN_URL,
      client_id: settings.clientId!,
      client_secret: settings.clientSecret!,
      scopes: (body.scope ?? '').split(/\s+/).filter((s) => s !== ''),
      expiry: typeof body.expires_in === 'number'
        ? new Date(this.now() + body.expires_in * 1000).toISOString().slice(0, 19)
        : null,
    };
    try {
      await writeWorkspaceToken(savedEmail, file, this.deps.home);
    } catch (err) {
      log.error({ errName: err instanceof Error ? err.name : typeof err, code: (err as NodeJS.ErrnoException).code }, 'google workspace sign-in: could not write the token file');
      return done('failed');
    }
    this.statusCache = null;

    // Signing in is the operator asking for Workspace, so the server is switched on too. A failure
    // here still leaves a good token: status() then reads "server off" and says how to fix it.
    if (this.deps.mcpServer) {
      try {
        if (!(await this.deps.mcpServer.isEnabled())) {
          await this.deps.mcpServer.enable();
          log.info('google workspace sign-in: turned the google-workspace MCP server on');
        }
      } catch (err) {
        log.error({ errName: err instanceof Error ? err.name : typeof err, errMessage: err instanceof Error ? err.message : undefined }, 'google workspace sign-in: could not turn the google-workspace MCP server on; enable it under Settings → MCP Skills');
      }
    }

    let restartScheduled = false;
    if (this.deps.scheduleRestart) {
      try {
        this.deps.scheduleRestart(WORKSPACE_RESTART_DELAY_MS);
        restartScheduled = true;
      } catch (err) {
        log.error({ errName: err instanceof Error ? err.name : typeof err }, 'google workspace sign-in: could not schedule the restart; restart Curia to use the new sign-in');
      }
    }
    return done('signed_in', restartScheduled);
  }

  /**
   * The live check. not_configured and not_signed_in need no network; otherwise the saved
   * refresh token is tried against Google. Throws WorkspaceCheckUnavailableError when Google
   * cannot be asked, so the caller reports "could not check" rather than a wrong answer.
   */
  async status(): Promise<WorkspaceSignInStatus> {
    const settings = await this.deps.readSettings();
    const missing = missingSettings(settings);
    if (missing.length > 0) return { state: 'not_configured', missing };

    // The exact saved string, as workspace-mcp names the file (see handleCallback).
    const email = settings.email!.trim();
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(workspaceCredentialPath(email, this.deps.home))).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not_signed_in' };
      this.deps.logger.error({ errName: err instanceof Error ? err.name : typeof err, code: (err as NodeJS.ErrnoException).code }, 'google workspace: could not stat the saved token file');
      return { state: 'token_rejected', detail: 'Curia can’t read its saved Google sign-in (file permissions). Fix the credentials directory’s owner, or sign in as Curia again.' };
    }
    const key = `${email}|${settings.clientId}|${mtimeMs}`;
    if (this.statusCache && this.statusCache.key === key && this.now() - this.statusCache.at < WORKSPACE_STATUS_CACHE_MS) {
      return this.withServerState(this.statusCache.status);
    }

    let saved: WorkspaceTokenFile | null;
    try {
      saved = await readWorkspaceToken(email, this.deps.home);
    } catch (err) {
      // Unreadable (permissions) or corrupt: waiting will not fix it, a fresh sign-in will.
      this.deps.logger.error({ errName: err instanceof Error ? err.name : typeof err, code: (err as NodeJS.ErrnoException).code }, 'google workspace: could not read the saved token file');
      return { state: 'token_rejected', detail: 'Curia can’t read its saved Google sign-in (file permissions, or a damaged file). Sign in as Curia again.' };
    }
    if (!saved?.refresh_token) return { state: 'not_signed_in' };

    // Refresh with the client the token was minted for, as workspace-mcp does.
    const result = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: saved.refresh_token,
      client_id: saved.client_id || settings.clientId!,
      client_secret: saved.client_secret || settings.clientSecret!,
    });
    let status: WorkspaceSignInStatus;
    if (result.kind === 'ok') {
      // Google omits `scope` on some refreshes; then the stored list is what was granted.
      const lacking = missingWorkspaceScopes(result.body.scope ?? (Array.isArray(saved.scopes) ? saved.scopes.join(' ') : ''));
      status = lacking.length === 0
        ? { state: 'signed_in' }
        : { state: 'token_rejected', detail: 'The saved sign-in does not cover Drive, Docs and Sheets. Sign in as Curia again and leave every box ticked.' };
    } else if (result.kind === 'rejected' && result.error !== undefined && (REJECTED_ERRORS[result.error] || result.status === 400 || result.status === 401)) {
      // Any 400/401 with an error code is Google refusing this sign-in (deleted_client, …), not an outage.
      status = {
        state: 'token_rejected',
        detail: REJECTED_ERRORS[result.error] ?? `Google refused the saved sign-in (${result.error.slice(0, 64)}). Check the OAuth client, then sign in as Curia again.`,
      };
    } else {
      throw new WorkspaceCheckUnavailableError(`Google could not complete the sign-in check (${result.kind === 'rejected' ? `HTTP ${result.status}${result.error ? ` ${result.error}` : ''}` : 'network error'}).`);
    }
    this.statusCache = { key, at: this.now(), status };
    return this.withServerState(status);
  }

  /** Adds the registry switch to a signed_in result. Read every time (a local query), never cached:
   *  the operator can flip it under Settings without touching the token. */
  private async withServerState(status: WorkspaceSignInStatus): Promise<WorkspaceSignInStatus> {
    if (status.state !== 'signed_in' || !this.deps.mcpServer) return status;
    return { state: 'signed_in', serverEnabled: await this.deps.mcpServer.isEnabled() };
  }

  /** Delete states lapsed or spent over an hour ago. Returns the number removed. */
  async pruneExpired(): Promise<number> {
    const res = await this.deps.pool.query(
      `DELETE FROM google_workspace_signin_states
        WHERE expires_at < now() - interval '1 hour' OR consumed_at < now() - interval '1 hour'`,
    );
    return res.rowCount ?? 0;
  }

  /** Spend a state atomically. A lapsed one is spent too, so it cannot be replayed. */
  private async claim(state: string): Promise<{ status: 'claimed'; verifier: string } | { status: 'expired' | 'used' | 'not_found' }> {
    const stateHash = hashToken(state);
    const res = await this.deps.pool.query<{ code_verifier: string; lapsed: boolean }>(
      `UPDATE google_workspace_signin_states SET consumed_at = now()
        WHERE state_hash = $1 AND consumed_at IS NULL
        RETURNING code_verifier, (expires_at <= now()) AS lapsed`,
      [stateHash],
    );
    const row = res.rows[0];
    if (row) return row.lapsed ? { status: 'expired' } : { status: 'claimed', verifier: row.code_verifier };
    const exists = await this.deps.pool.query('SELECT 1 FROM google_workspace_signin_states WHERE state_hash = $1', [stateHash]);
    return { status: exists.rowCount === 0 ? 'not_found' : 'used' };
  }

  private async tokenRequest(form: Record<string, string>): Promise<
    | { kind: 'ok'; body: TokenResponse }
    | { kind: 'rejected'; status: number; error: string | undefined }
    | { kind: 'unreachable' }
  > {
    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'google workspace: token endpoint unreachable');
      return { kind: 'unreachable' };
    }
    let body: TokenResponse = {};
    try {
      body = await res.json() as TokenResponse;
    } catch (err) {
      // A non-JSON answer (a proxy page, a truncated body): no error code to report, only the status.
      this.deps.logger.warn({ status: res.status, errName: err instanceof Error ? err.name : typeof err }, 'google workspace: token endpoint answered non-JSON');
    }
    if (res.ok) return { kind: 'ok', body };
    return { kind: 'rejected', status: res.status, error: typeof body.error === 'string' ? body.error : undefined };
  }

  /** Best effort: a refused sign-in should not leave a live grant behind on Google's side. */
  private async revoke(body: TokenResponse): Promise<void> {
    const token = body.refresh_token ?? body.access_token;
    if (!token) return;
    try {
      const res = await this.fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.deps.logger.warn({ status: res.status }, 'google workspace sign-in: could not revoke the refused grant');
    } catch (err) {
      this.deps.logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'google workspace sign-in: could not revoke the refused grant');
    }
  }
}

function missingSettings(s: WorkspaceSettings): string[] {
  const missing: string[] = [];
  if (!s.email?.trim()) missing.push('Curia’s Google address');
  if (!s.clientId?.trim()) missing.push('the OAuth client ID');
  if (!s.clientSecret?.trim()) missing.push('the OAuth client secret');
  return missing;
}
