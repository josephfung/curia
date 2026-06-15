// secret-capture-service.ts — mint & redeem one-time tokens for agent-initiated
// secret capture (#971).
//
// The structural guarantee: this service is the ONLY path a capture link takes, and it
// has no method that returns a stored secret VALUE. Agents mint a token (which only ever
// yields a URL), the user submits the value to the public form, and redeem() writes it
// straight into the encrypted vault. The token store holds metadata only — never the value.
//
// Two name policies live here as pure functions so the two sibling skills can share one
// service and differ only in WHICH policy they apply:
//   - resolveUserSecretName   — slugifies to `user.<slug>`; an unprivileged agent literally
//                               cannot name a system/channel key (no dot-free or `channel.`
//                               output is possible), so it is sandboxed by construction.
//   - resolveSystemSecretName — must be a declared skill secret or channel credential key
//                               (the same allowlist the vault PUT route enforces).

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { hashToken } from '../channels/http/session-auth.js';
import { randomBytes } from 'node:crypto';

export type CaptureValueFormat = 'string' | 'json';

/** Default link lifetime — short by design (single-use + 30 min, per #971). */
export const DEFAULT_CAPTURE_TTL_MINUTES = 30;

/** Upper bound on the raw user-supplied name before slugification. */
const MAX_SECRET_NAME_INPUT = 128;

/**
 * Slugify an arbitrary user description into a `user.<a-z0-9_>+` vault key.
 *
 * The `user.` namespace is the sandbox: the dot-separated prefix cannot be produced by
 * snake_case system keys (e.g. `anthropic_api_key`) or `channel.*` credential keys, so a
 * general-purpose capture can never overwrite a privileged secret — even if the agent
 * passes the literal name of one (it just becomes `user.anthropic_api_key`).
 */
export function resolveUserSecretName(input: string): string {
  if (typeof input !== 'string') throw new Error('secret_name must be a string');
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error('secret_name must not be empty');
  if (trimmed.length > MAX_SECRET_NAME_INPUT) {
    throw new Error(`secret_name exceeds ${MAX_SECRET_NAME_INPUT} characters`);
  }
  // Lowercase, collapse every non-alphanumeric run to a single underscore, trim edge underscores.
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug.length === 0) {
    throw new Error(`secret_name '${input}' has no usable alphanumeric characters`);
  }
  return `user.${slug}`;
}

/**
 * Validate a system secret name against the live allowlist (declared skill secrets ∪ known
 * channel credential keys). The literal name is used as the vault key — system secrets are
 * fixed identifiers, not free text, so we never slugify here.
 */
export function resolveSystemSecretName(input: string, allowedNames: ReadonlySet<string>): string {
  if (typeof input !== 'string') throw new Error('secret_name must be a string');
  const name = input.trim();
  if (name.length === 0) throw new Error('secret_name must not be empty');
  if (!allowedNames.has(name)) {
    throw new Error(
      `'${name}' is not a secret declared by any skill (install.requires_secrets) ` +
      `nor a known channel credential key. Only those names may be captured by ` +
      `system-secret-capture-request.`,
    );
  }
  return name;
}

/** The narrow slice of SecretsService that redeem() needs — write a value, never read one. */
export interface CaptureSecretsPort {
  set(name: string, value: string): Promise<void>;
  setJSON(name: string, obj: unknown): Promise<void>;
}

/** The mint-only surface injected into skills as the `secretCapture` capability.
 *  Deliberately excludes redeem/getMetadata so a skill can create a link but never read a value. */
export interface SecretCaptureMinter {
  mintUserSecret(args: MintNameArgs): Promise<MintResult>;
  mintSystemSecret(args: MintNameArgs): Promise<MintResult>;
}

/**
 * Origin routing context captured at mint time (#972). Persisted on the token row alongside
 * the metadata so that when the value is redeemed the capture endpoint can publish a
 * `secret.captured` event with enough context to re-enter the originating agent. Holds NO
 * secret material — only conversation/agent/channel routing and the original ask. Every field
 * is optional: a token minted outside an agent context simply has no routable origin and is
 * never resumed.
 */
export interface CaptureOrigin {
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  /** The originating agent.task event id — threaded as parentEventId on the resume task. */
  taskEventId?: string;
  /** The TaskOriginator that started the chain. Round-tripped opaquely (stored as JSONB). */
  originator?: Record<string, unknown>;
  /** Natural-language description of what to resume, e.g. the original user ask. */
  resumeIntent?: string;
}

export interface MintNameArgs {
  /** Raw, unresolved name from the skill input. Resolution depends on the policy. */
  rawName: string;
  label?: string;
  valueFormat?: CaptureValueFormat;
  /** Origin routing context (#972), persisted so redeem can re-enter the agent. Optional. */
  origin?: CaptureOrigin;
  // NOTE: TTL is intentionally NOT caller-controlled. The lifetime is a fixed security
  // property of the feature (single-use + 30 min, per #971), so callers cannot mint links
  // that are already dead, absurdly long-lived, or NaN. See DEFAULT_CAPTURE_TTL_MINUTES.
}

export interface MintResult {
  rawToken: string;
  /** The fully resolved vault key the value will be written to. */
  secretName: string;
  expiresAt: Date;
}

export interface SecretCaptureServiceOptions {
  /** Returns the live allowlist for system captures (declared secrets ∪ channel keys).
   *  A thunk (not a static set) so it reflects the registry state at mint time. */
  getAllowedSystemNames: () => ReadonlySet<string>;
  /** Logger for the one operator-actionable failure mode: a token stranded consumed-but-unsaved
   *  when the post-vault-failure rollback itself fails. Optional so tests can omit it. */
  logger?: Logger;
}

/** Status of a redeem attempt. Vault-write failures are not in this union — they rethrow
 *  (after clearing consumed_at) so the route surfaces a 500 and the user can retry. */
export type RedeemStatus = 'ok' | 'expired' | 'not_found' | 'invalid_json';

/**
 * Routing context returned on a successful redeem (#972). Carries the secret NAME/label and
 * the origin captured at mint time — NEVER the value — so the capture endpoint can publish a
 * `secret.captured` event without re-reading the DB. Mirrors CaptureOrigin plus the resolved
 * secret name/label.
 */
export interface CapturedContext {
  secretName: string;
  label: string | null;
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  taskEventId?: string;
  originator?: Record<string, unknown>;
  resumeIntent?: string;
}

/**
 * Outcome of a redeem attempt. On 'ok' it carries the captured routing context; every other
 * status carries nothing. Only a real (winning) claim returns 'ok' with context, so a replayed
 * redeem of an already-consumed token returns 'expired' and the route publishes no event —
 * exactly one secret.captured per capture.
 */
export type RedeemOutcome =
  | { status: 'ok'; captured: CapturedContext }
  | { status: 'expired' | 'not_found' | 'invalid_json' };

export type CaptureMetadata =
  | { label: string | null; valueFormat: CaptureValueFormat }
  | 'expired'
  | 'not_found';

export class SecretCaptureService implements SecretCaptureMinter {
  constructor(
    private readonly pool: DbPool,
    private readonly secrets: CaptureSecretsPort,
    private readonly options: SecretCaptureServiceOptions,
  ) {}

  /**
   * Low-level mint — PRIVATE on purpose. The only public entry points are mintUserSecret /
   * mintSystemSecret, which each run a name policy first. Keeping this private means no holder
   * of a SecretCaptureService can bypass the `user.` namespace sandbox or the system allowlist
   * by passing an arbitrary secretName. TTL is fixed (not a parameter) for the same reason.
   */
  private async mint(secretName: string, label: string | undefined, valueFormat: CaptureValueFormat, origin?: CaptureOrigin): Promise<{ rawToken: string; expiresAt: Date }> {
    // 128-bit raw token, base64url-encoded → a short (~22 char) mixed-case slug that reads
    // like an ordinary magic-link id, NOT a 64-char hex hash. Two reasons for this shape:
    //   1. The relaying LLM was self-redacting the old hex token (it pattern-matched a long
    //      hex string in a "secret-capture" context as a credential and printed [REDACTED]).
    //      A short base64url slug doesn't trip that instinct.
    //   2. It matches none of the secret-scrub regexes (not a 32+ hex run, no sk-/AKIA/Bearer).
    // 128 bits is still cryptographically unguessable for a single-use, 30-minute, rate-limited
    // link. The token lives only in the URL; we persist its hash (session-auth pattern).
    const rawToken = randomBytes(16).toString('base64url');
    const tokenHash = hashToken(rawToken);
    // Compute expires_at from the DB clock (now() + TTL), not the app clock, and read it back.
    // Redemption/metadata also compare against the DB now(), so mint and redeem share one time
    // source — app/DB clock skew can never make a link expire early or linger past its TTL.
    // The routing columns (#972) are nullable and round-tripped only — they hold no secret
    // material. originator is passed as an object so node-postgres serializes it to the JSONB
    // column; the rest are plain text. A mint with no origin writes NULLs (backward compatible
    // with #971), and such a token is simply never resumed.
    const result = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO secret_capture_tokens
         (token_hash, secret_name, label, value_format, expires_at,
          conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7, $8, $9, $10, $11)
       RETURNING expires_at`,
      [
        tokenHash, secretName, label ?? null, valueFormat, DEFAULT_CAPTURE_TTL_MINUTES,
        origin?.conversationId ?? null,
        origin?.channelId ?? null,
        origin?.agentId ?? null,
        origin?.taskEventId ?? null,
        origin?.originator ?? null,
        origin?.resumeIntent ?? null,
      ],
    );
    return { rawToken, expiresAt: result.rows[0]!.expires_at };
  }

  async mintUserSecret(args: MintNameArgs): Promise<MintResult> {
    const secretName = resolveUserSecretName(args.rawName);
    const { rawToken, expiresAt } = await this.mint(secretName, args.label, args.valueFormat ?? 'string', args.origin);
    return { rawToken, secretName, expiresAt };
  }

  async mintSystemSecret(args: MintNameArgs): Promise<MintResult> {
    const secretName = resolveSystemSecretName(args.rawName, this.options.getAllowedSystemNames());
    const { rawToken, expiresAt } = await this.mint(secretName, args.label, args.valueFormat ?? 'string', args.origin);
    return { rawToken, secretName, expiresAt };
  }

  /** Metadata for the public GET endpoint. Never returns the vault key (secret_name).
   *  `spent` is computed in SQL with the DB clock (`now()`), the same time source the atomic
   *  claim uses — so metadata and redemption never disagree about validity under clock skew. */
  async getMetadata(rawToken: string): Promise<CaptureMetadata> {
    const res = await this.pool.query<{
      label: string | null;
      value_format: CaptureValueFormat;
      spent: boolean;
    }>(
      `SELECT label, value_format,
              (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    const row = res.rows[0];
    if (!row) return 'not_found';
    if (row.spent) return 'expired';
    return { label: row.label, valueFormat: row.value_format };
  }

  /**
   * Atomically claim and redeem a capture token, writing the value into the vault.
   *
   * JSON is validated BEFORE the atomic claim so a malformed submission does not burn the
   * single-use token (the user can fix and resubmit). The claim's WHERE clause re-checks
   * single-use/expiry atomically, so concurrent submissions cannot both win.
   */
  async redeem(rawToken: string, value: string): Promise<RedeemOutcome> {
    const tokenHash = hashToken(rawToken);

    // Peek to distinguish not_found / expired / invalid_json before mutating anything.
    // `spent` uses the DB clock (`now()`) — the same source as the atomic claim below — so the
    // pre-check and the claim agree on validity regardless of app/DB clock skew.
    const peek = await this.pool.query<{
      value_format: CaptureValueFormat;
      spent: boolean;
    }>(
      `SELECT value_format,
              (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = peek.rows[0];
    if (!row) return { status: 'not_found' };
    if (row.spent) return { status: 'expired' };

    let parsed: unknown;
    if (row.value_format === 'json') {
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        // Log (never the value) so a malformed submission is traceable, then surface invalid_json.
        // The token is NOT burned — the user can fix and resubmit.
        this.options.logger?.warn({ err }, 'secret-capture: invalid JSON payload during redeem — token left unspent for retry');
        return { status: 'invalid_json' };
      }
    }

    // Atomic single-use claim. RETURNING is empty if another request already consumed it
    // or it expired in the gap since the peek — both map to 'expired'.
    //
    // We consume the token BEFORE writing to the vault (not after) so a crash between the two
    // can never leave a redeemable token whose value was already stored. The failure direction
    // is "capability lost, retry needed" rather than "single-use token still reusable".
    //
    // RETURNING also pulls the routing columns (#972) so the caller can publish secret.captured
    // without a second read. Only the winning claim returns a row, so a replayed redeem of an
    // already-consumed token falls through to 'expired' and yields no captured context — the
    // route then publishes nothing, giving exactly one event per real capture.
    const claim = await this.pool.query<{
      secret_name: string;
      value_format: CaptureValueFormat;
      label: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      agent_id: string | null;
      task_event_id: string | null;
      originator: Record<string, unknown> | null;
      resume_intent: string | null;
    }>(
      `UPDATE secret_capture_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING secret_name, value_format, label,
                  conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent`,
      [tokenHash],
    );
    const claimed = claim.rows[0];
    if (!claimed) return { status: 'expired' };

    try {
      if (claimed.value_format === 'json') {
        await this.secrets.setJSON(claimed.secret_name, parsed);
      } else {
        await this.secrets.set(claimed.secret_name, value);
      }
    } catch (err) {
      // Roll the token back to unconsumed so the user can retry — but only if it is still live
      // (the `expires_at > now()` guard avoids resurrecting consumed_at on an already-dead row).
      // The rollback is wrapped so that if IT fails (e.g. the same DB outage that failed the
      // vault write), the ORIGINAL vault error still propagates and we log the stranded token
      // for an operator. The value is never logged — only the failure.
      try {
        await this.pool.query(
          `UPDATE secret_capture_tokens SET consumed_at = NULL
            WHERE token_hash = $1 AND expires_at > now()`,
          [tokenHash],
        );
      } catch (rollbackErr) {
        this.options.logger?.error(
          { err: rollbackErr },
          'secret-capture: failed to roll back consumed_at after a vault-write error — ' +
          'token is stranded consumed-but-unsaved; the user cannot retry and must be re-issued a link',
        );
      }
      throw err; // always the original vault-write error, never the rollback error
    }
    // Return the routing context (NEVER the value) so the caller can publish secret.captured.
    // Normalize SQL NULLs to undefined so the event payload omits absent fields cleanly.
    return {
      status: 'ok',
      captured: {
        secretName: claimed.secret_name,
        label: claimed.label,
        conversationId: claimed.conversation_id ?? undefined,
        channelId: claimed.channel_id ?? undefined,
        agentId: claimed.agent_id ?? undefined,
        taskEventId: claimed.task_event_id ?? undefined,
        originator: claimed.originator ?? undefined,
        resumeIntent: claimed.resume_intent ?? undefined,
      },
    };
  }
}
