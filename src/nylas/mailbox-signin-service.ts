// mailbox-signin-service.ts — single-use links for signing in to a mailbox through Nylas hosted
// auth (#2361). Modelled on SecretCaptureService: the raw token is 128 random bits, base64url,
// shown only in the link (and echoed back as the OAuth `state`); the table keeps its sha256 hash.
//
// The service never touches a grant, a Nylas key or an authorization code. It mints a link only
// while sign-in is ready, and hands the callback an atomically claimed row.

import { randomBytes } from 'node:crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { hashToken } from '../channels/http/session-auth.js';
import type { CaptureOrigin } from '../secrets/secret-capture-service.js';
import type { NylasSignInReadiness } from './signin-readiness.js';

/** Whose mailbox the link signs in: the principal's, or Curia's own. */
export type SignInTarget = 'principal' | 'curia';

export const DEFAULT_SIGNIN_TTL_MINUTES = 60;
/** A week. A link is single-use and unguessable, but a longer life only widens the window. */
export const MAX_SIGNIN_TTL_MINUTES = 10080;

type NotReadyReason = Extract<NylasSignInReadiness, { ready: false }>['reason'];

/** Thrown by mint() when sign-in is not usable. `reason` is the readiness reason; `detail` is
 *  operator-facing text that never carries the key or any Nylas response body. */
export class MailboxSignInUnavailableError extends Error {
  constructor(readonly reason: NotReadyReason, readonly detail: string = '') {
    super(detail !== '' ? `Mailbox sign-in is unavailable (${reason}): ${detail}` : `Mailbox sign-in is unavailable (${reason})`);
    this.name = 'MailboxSignInUnavailableError';
  }
}

/** The row peek() and consume() return. Column names as stored; the token hash is left out. */
export interface SignInTokenRow {
  target: SignInTarget;
  expected_email: string | null;
  mailbox_label: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  conversation_id: string | null;
  channel_id: string | null;
  agent_id: string | null;
  task_event_id: string | null;
  originator: Record<string, unknown> | null;
  resume_token: string | null;
}

export interface MintSignInArgs {
  target: SignInTarget;
  /** Rarely needed: for 'principal' the service fills the principal's primary verified address
   *  itself, so it never comes from model input (ADR-047). */
  expectedEmail?: string;
  label?: string;
  origin?: CaptureOrigin;
  ttlMinutes?: number;
}

/** The mint-only surface injected into skills as the `mailboxSignIn` capability. */
export interface MailboxSignInMinter {
  mint(args: MintSignInArgs): Promise<{ url: string; expiresAt: Date }>;
}

export interface MailboxSignInServiceDeps {
  pool: DbPool;
  logger: Logger;
  /** Live readiness, asked on every mint. */
  readiness: () => Promise<NylasSignInReadiness>;
  /** The console's public origin (APP_ORIGIN); the link is built from it. */
  appOrigin: string | undefined;
  /** The principal's primary verified email, or null when they have none. Read at mint time. */
  resolvePrincipalEmail?: () => string | null;
}

const ROW_COLUMNS = `target, expected_email, mailbox_label, expires_at, consumed_at, created_at,
  conversation_id, channel_id, agent_id, task_event_id, originator, resume_token`;

function clampTtlMinutes(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SIGNIN_TTL_MINUTES;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_SIGNIN_TTL_MINUTES);
}

export class MailboxSignInService implements MailboxSignInMinter {
  constructor(private readonly deps: MailboxSignInServiceDeps) {}

  async mint(args: MintSignInArgs): Promise<{ url: string; expiresAt: Date }> {
    const readiness = await this.deps.readiness();
    if (!readiness.ready) throw new MailboxSignInUnavailableError(readiness.reason, readiness.detail);
    const origin = this.deps.appOrigin;
    // Readiness already requires an https origin; this narrows the type and guards a drift.
    if (origin === undefined || !origin.startsWith('https://')) throw new MailboxSignInUnavailableError('origin_not_https');

    const expectedEmail = args.target === 'principal'
      ? (args.expectedEmail ?? this.deps.resolvePrincipalEmail?.() ?? null)
      : null;

    // 128-bit base64url slug (~22 chars), the same shape as capture links: short enough that a
    // relaying model does not mistake it for a credential and redact it.
    const rawToken = randomBytes(16).toString('base64url');
    // expires_at comes from the DB clock and is read back, so mint and consume share one clock.
    const res = await this.deps.pool.query<{ expires_at: Date }>(
      `INSERT INTO mailbox_signin_tokens
         (token_hash, target, expected_email, mailbox_label, expires_at,
          conversation_id, channel_id, agent_id, task_event_id, originator, resume_token)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7, $8, $9, $10, $11)
       RETURNING expires_at`,
      [
        hashToken(rawToken), args.target, expectedEmail, args.label ?? null, clampTtlMinutes(args.ttlMinutes),
        args.origin?.conversationId ?? null,
        args.origin?.channelId ?? null,
        args.origin?.agentId ?? null,
        args.origin?.taskEventId ?? null,
        args.origin?.originator ?? null,
        args.origin?.resumeToken ?? null,
      ],
    );
    // The token is never logged; only that a link of this kind was minted.
    this.deps.logger.info({ target: args.target, hasExpectedEmail: expectedEmail !== null }, 'mailbox sign-in link minted');
    return {
      url: `${origin.replace(/\/+$/, '')}/api/mailbox-signin/start/${rawToken}`,
      expiresAt: res.rows[0]!.expires_at,
    };
  }

  /** Read a link without spending it. A spent or lapsed link is 'expired'. */
  async peek(rawToken: string): Promise<SignInTokenRow | 'expired' | 'not_found'> {
    const res = await this.deps.pool.query<SignInTokenRow & { spent: boolean }>(
      `SELECT ${ROW_COLUMNS}, (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM mailbox_signin_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    const found = res.rows[0];
    if (!found) return 'not_found';
    if (found.spent) return 'expired';
    return toRow(found);
  }

  /**
   * Atomically claim a link. One UPDATE spends it, whether or not it has lapsed, so an expired
   * token cannot be replayed; the same statement tells a lapsed claim from a live one.
   */
  async consume(rawToken: string): Promise<SignInTokenRow | 'expired' | 'not_found' | 'used'> {
    const tokenHash = hashToken(rawToken);
    const claim = await this.deps.pool.query<SignInTokenRow & { lapsed: boolean }>(
      `UPDATE mailbox_signin_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL
        RETURNING ${ROW_COLUMNS}, (expires_at <= now()) AS lapsed`,
      [tokenHash],
    );
    const claimed = claim.rows[0];
    if (claimed) return claimed.lapsed ? 'expired' : toRow(claimed);
    // Nothing was claimed: either the link was already spent, or it never existed.
    const exists = await this.deps.pool.query('SELECT 1 FROM mailbox_signin_tokens WHERE token_hash = $1', [tokenHash]);
    return exists.rowCount === 0 ? 'not_found' : 'used';
  }
}

/** Keep only the stored columns; the SELECT/UPDATE adds a computed flag that is not part of the row. */
function toRow(found: SignInTokenRow & { spent?: boolean; lapsed?: boolean }): SignInTokenRow {
  return {
    target: found.target,
    expected_email: found.expected_email,
    mailbox_label: found.mailbox_label,
    expires_at: found.expires_at,
    consumed_at: found.consumed_at,
    created_at: found.created_at,
    conversation_id: found.conversation_id,
    channel_id: found.channel_id,
    agent_id: found.agent_id,
    task_event_id: found.task_event_id,
    originator: found.originator,
    resume_token: found.resume_token,
  };
}
