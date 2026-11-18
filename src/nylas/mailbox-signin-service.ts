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

/** Thrown by mint() when a principal link cannot be pinned to one of the principal's own
 *  verified addresses. `unknown_principal_address`: the requested address is not one of them.
 *  `no_principal_address`: none was requested and none can be chosen (no designated primary and
 *  not exactly one verified address). */
export class MailboxSignInAddressError extends Error {
  constructor(readonly reason: 'unknown_principal_address' | 'no_principal_address') {
    super(
      reason === 'unknown_principal_address'
        ? "That address is not one of the principal's verified email addresses. Connecting a new account is done by the operator from the console."
        : "The principal has no designated primary email address, so there is no mailbox address to sign in. Ask them which of their verified addresses to use, or set a primary in the console.",
    );
    this.name = 'MailboxSignInAddressError';
  }
}

export interface MintSignInArgs {
  target: SignInTarget;
  /** For 'principal': one of the principal's verified addresses (case-insensitive). Omitted means
   *  the designated primary. Anything else is refused; it never reaches the DB unchecked. */
  mailboxAddress?: string;
  label?: string;
  origin?: CaptureOrigin;
  ttlMinutes?: number;
}

/** Operator-facing mint (console, Task 7): may pin the link to an address that is not yet a
 *  verified identity, which skills must never be able to do. Not part of MailboxSignInMinter. */
export interface OperatorMintSignInArgs extends Omit<MintSignInArgs, 'mailboxAddress'> {
  expectedEmail?: string;
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
  /** The principal's verified email addresses and the designated primary (or null), read at mint
   *  time so a change applies without a restart. */
  principalEmails?: () => { primary: string | null; all: readonly string[] };
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
    const { mailboxAddress, ...rest } = args;
    const expectedEmail = rest.target === 'principal' ? this.resolvePrincipalAddress(mailboxAddress) : null;
    return this.insert(rest, expectedEmail);
  }

  /** Operator path: the caller supplies the address (or none, for any account). */
  async mintForOperator(args: OperatorMintSignInArgs): Promise<{ url: string; expiresAt: Date }> {
    const { expectedEmail, ...rest } = args;
    return this.insert(rest, expectedEmail?.trim().toLowerCase() || null);
  }

  /**
   * Pick the address a principal link is pinned to. Fails closed: a principal link is never
   * minted with no address, because that would let any Google account sign in as the principal.
   */
  private resolvePrincipalAddress(requested: string | undefined): string {
    const { primary, all } = this.deps.principalEmails?.() ?? { primary: null, all: [] };
    const verified = all.map((a) => a.trim().toLowerCase()).filter((a) => a !== '');
    if (requested !== undefined) {
      const want = requested.trim().toLowerCase();
      if (!verified.includes(want)) throw new MailboxSignInAddressError('unknown_principal_address');
      return want;
    }
    const designated = primary?.trim().toLowerCase();
    if (designated && verified.includes(designated)) return designated;
    const only = [...new Set(verified)];
    if (only.length === 1) return only[0]!;
    throw new MailboxSignInAddressError('no_principal_address');
  }

  private async insert(
    args: Omit<MintSignInArgs, 'mailboxAddress'>,
    expectedEmail: string | null,
  ): Promise<{ url: string; expiresAt: Date }> {
    const readiness = await this.deps.readiness();
    if (!readiness.ready) throw new MailboxSignInUnavailableError(readiness.reason, readiness.detail);
    const origin = this.deps.appOrigin;
    // Readiness already requires an https origin; this narrows the type and guards a drift.
    if (origin === undefined || !origin.startsWith('https://')) throw new MailboxSignInUnavailableError('origin_not_https');

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

  /** Read a link without spending it. A spent link is 'used'; a lapsed one is 'expired'. */
  async peek(rawToken: string): Promise<SignInTokenRow | 'expired' | 'used' | 'not_found'> {
    const res = await this.deps.pool.query<SignInTokenRow & { spent: boolean }>(
      `SELECT ${ROW_COLUMNS}, (expires_at <= now()) AS spent
         FROM mailbox_signin_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    const found = res.rows[0];
    if (!found) return 'not_found';
    if (found.consumed_at !== null) return 'used';
    if (found.spent) return 'expired';
    return toRow(found);
  }

  /** Delete lapsed rows, and rows spent over an hour ago. Returns the number removed. */
  async pruneExpired(): Promise<number> {
    const res = await this.deps.pool.query(
      `DELETE FROM mailbox_signin_tokens
        WHERE expires_at < now() OR consumed_at < now() - interval '1 hour'`,
    );
    return res.rowCount ?? 0;
  }

  /**
   * Atomically claim a link. One UPDATE spends it, whether or not it has lapsed, so an expired
   * token cannot be replayed; the same statement tells a lapsed claim from a live one.
   */
  async consume(rawToken: string): Promise<SignInTokenRow | 'expired' | 'not_found' | 'used'> {
    const claimed = await this.claim(rawToken);
    return claimed.status === 'claimed' ? claimed.row : claimed.status;
  }

  /**
   * consume(), but a lapsed claim keeps its row: the callback still owes the originating agent a
   * `mailbox_signin.finished` with outcome `expired`, and the row carries that agent's routing.
   */
  async claim(rawToken: string): Promise<SignInClaim> {
    const tokenHash = hashToken(rawToken);
    const claim = await this.deps.pool.query<SignInTokenRow & { lapsed: boolean }>(
      `UPDATE mailbox_signin_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL
        RETURNING ${ROW_COLUMNS}, (expires_at <= now()) AS lapsed`,
      [tokenHash],
    );
    const claimed = claim.rows[0];
    if (claimed) return claimed.lapsed ? { status: 'expired', row: toRow(claimed) } : { status: 'claimed', row: toRow(claimed) };
    // Nothing was claimed: either the link was already spent, or it never existed.
    const exists = await this.deps.pool.query('SELECT 1 FROM mailbox_signin_tokens WHERE token_hash = $1', [tokenHash]);
    return exists.rowCount === 0 ? { status: 'not_found' } : { status: 'used' };
  }
}

/** What claim() found. A lapsed link is spent all the same, and comes back with its row. */
export type SignInClaim =
  | { status: 'claimed'; row: SignInTokenRow }
  | { status: 'expired'; row: SignInTokenRow }
  | { status: 'not_found' }
  | { status: 'used' };

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
