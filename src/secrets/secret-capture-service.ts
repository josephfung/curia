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

export interface MintNameArgs {
  /** Raw, unresolved name from the skill input. Resolution depends on the policy. */
  rawName: string;
  label?: string;
  valueFormat?: CaptureValueFormat;
  ttlMinutes?: number;
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
}

/** Outcome of a redeem attempt. Vault-write failures are not in this union — they rethrow
 *  (after clearing consumed_at) so the route surfaces a 500 and the user can retry. */
export type RedeemResult = 'ok' | 'expired' | 'not_found' | 'invalid_json';

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

  /** Low-level mint: secretName is assumed already resolved & validated by the caller. */
  async mint(args: {
    secretName: string;
    label?: string;
    valueFormat: CaptureValueFormat;
    ttlMinutes: number;
  }): Promise<{ rawToken: string; expiresAt: Date }> {
    // 256-bit raw token — lives only in the returned URL. We persist its hash, matching the
    // session-auth pattern, so a DB compromise cannot reconstruct a usable capture link.
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + args.ttlMinutes * 60_000);
    await this.pool.query(
      `INSERT INTO secret_capture_tokens (token_hash, secret_name, label, value_format, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tokenHash, args.secretName, args.label ?? null, args.valueFormat, expiresAt],
    );
    return { rawToken, expiresAt };
  }

  async mintUserSecret(args: MintNameArgs): Promise<MintResult> {
    const secretName = resolveUserSecretName(args.rawName);
    const { rawToken, expiresAt } = await this.mint({
      secretName,
      label: args.label,
      valueFormat: args.valueFormat ?? 'string',
      ttlMinutes: args.ttlMinutes ?? DEFAULT_CAPTURE_TTL_MINUTES,
    });
    return { rawToken, secretName, expiresAt };
  }

  async mintSystemSecret(args: MintNameArgs): Promise<MintResult> {
    const secretName = resolveSystemSecretName(args.rawName, this.options.getAllowedSystemNames());
    const { rawToken, expiresAt } = await this.mint({
      secretName,
      label: args.label,
      valueFormat: args.valueFormat ?? 'string',
      ttlMinutes: args.ttlMinutes ?? DEFAULT_CAPTURE_TTL_MINUTES,
    });
    return { rawToken, secretName, expiresAt };
  }

  /** Metadata for the public GET endpoint. Never returns the vault key (secret_name). */
  async getMetadata(rawToken: string): Promise<CaptureMetadata> {
    const res = await this.pool.query<{
      label: string | null;
      value_format: CaptureValueFormat;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT label, value_format, expires_at, consumed_at
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    const row = res.rows[0];
    if (!row) return 'not_found';
    if (this.isSpent(row.consumed_at, row.expires_at)) return 'expired';
    return { label: row.label, valueFormat: row.value_format };
  }

  /**
   * Atomically claim and redeem a capture token, writing the value into the vault.
   *
   * JSON is validated BEFORE the atomic claim so a malformed submission does not burn the
   * single-use token (the user can fix and resubmit). The claim's WHERE clause re-checks
   * single-use/expiry atomically, so concurrent submissions cannot both win.
   */
  async redeem(rawToken: string, value: string): Promise<RedeemResult> {
    const tokenHash = hashToken(rawToken);

    // Peek to distinguish not_found / expired / invalid_json before mutating anything.
    const peek = await this.pool.query<{
      value_format: CaptureValueFormat;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT value_format, expires_at, consumed_at
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = peek.rows[0];
    if (!row) return 'not_found';
    if (this.isSpent(row.consumed_at, row.expires_at)) return 'expired';

    let parsed: unknown;
    if (row.value_format === 'json') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return 'invalid_json';
      }
    }

    // Atomic single-use claim. RETURNING is empty if another request already consumed it
    // or it expired in the gap since the peek — both map to 'expired'.
    const claim = await this.pool.query<{ secret_name: string; value_format: CaptureValueFormat }>(
      `UPDATE secret_capture_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING secret_name, value_format`,
      [tokenHash],
    );
    const claimed = claim.rows[0];
    if (!claimed) return 'expired';

    try {
      if (claimed.value_format === 'json') {
        await this.secrets.setJSON(claimed.secret_name, parsed);
      } else {
        await this.secrets.set(claimed.secret_name, value);
      }
    } catch (err) {
      // Roll the token back to unconsumed so the user can retry the submission. The value
      // is never logged — only the failure propagates.
      await this.pool.query(
        `UPDATE secret_capture_tokens SET consumed_at = NULL WHERE token_hash = $1`,
        [tokenHash],
      );
      throw err;
    }
    return 'ok';
  }

  /** A token is spent if it has been consumed or its expiry has passed. */
  private isSpent(consumedAt: Date | null, expiresAt: Date): boolean {
    return consumedAt !== null || new Date(expiresAt).getTime() <= Date.now();
  }
}
