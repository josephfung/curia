// secret-capture-service.ts — mint & redeem one-time tokens for agent-initiated
// secret capture (#971).
//
// The structural guarantee: this service is the ONLY path a capture link takes, and it
// has no method that returns a stored secret VALUE. Agents mint a token (which only ever
// yields a URL), the user submits the value to the public form, and redeem() writes it
// straight into the encrypted vault. The token store holds metadata only — never the value.
//
// Two name policies live here so the two sibling skills can share one service and
// differ only in WHICH policy they apply:
//   - resolveUserSecretName   — canonical `user.*` key with fingerprint dedup (#1497);
//                               an unprivileged agent literally cannot name a system/channel
//                               key (no dot-free or `channel.` output is possible).
//   - resolveSystemSecretName — must be a declared skill secret or channel credential key
//                               (the same allowlist the vault PUT route enforces).

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { hashToken } from '../channels/http/session-auth.js';
import { randomBytes } from 'node:crypto';
import { resolveUserSecretName } from './user-secret-name.js';
import { hasUserSecretDetails, type UserSecretDetails } from './user-secret-details.js';
import {
  CARD_VALIDATION_MESSAGES,
  normalizeCardLabel,
  validateCardPublicPatch,
  validateCreditCard,
  validateCvv,
  type CardBrand,
  type CardValidationReason,
  type CreditCardPublicFields,
  type CreditCardSecretDoc,
} from './structured-secret-schema.js';

export { resolveUserSecretName } from './user-secret-name.js';

export type CaptureValueFormat = 'string' | 'json';

/** Form templates a capture link can carry (#1358). `credit_card` saves a new card;
 *  `credit_card_renewal` swaps the expiry and security code of a saved one. */
export type CaptureTemplate = 'credit_card' | 'credit_card_renewal';

/** Edit to a saved card's non-secret fields. Values are unvalidated input; the service validates. */
export interface CardPublicEdit {
  label?: unknown;
  expiry_month?: unknown;
  expiry_year?: unknown;
  cardholder_name?: unknown;
  billing_zip?: unknown;
}

/** Default link lifetime — short by design (single-use + 30 min, per #971). */
export const DEFAULT_CAPTURE_TTL_MINUTES = 30;

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
      `'${name}' is not a secret declared by any skill (install.requires_secrets or optional_secrets) ` +
      `nor a known channel credential key. Only those names may be captured by ` +
      `system-secret-capture-request.`,
    );
  }
  return name;
}

/** The narrow slice of SecretsService that capture needs — write a value, never read one.
 *  `listUserNames` is names-only / `user.*`-only so mint can dedup without seeing values
 *  or the rest of the keyspace (#1497). */
export interface CaptureSecretsPort {
  set(name: string, value: string): Promise<void>;
  setJSON(name: string, obj: unknown): Promise<void>;
  listUserNames(): Promise<string[]>;
  /** Non-secret sign-in details for a `user.*` key (#2201). */
  upsertUserDetails(name: string, details: UserSecretDetails): Promise<void>;
  /** Saved cards (#1358). Public fields only on the read side; the writes take already-validated values. */
  getCardPublic(name: string): Promise<{ label: string | null; publicFields: CreditCardPublicFields } | null>;
  setCard(name: string, secret: CreditCardSecretDoc, publicFields: CreditCardPublicFields, label: string | null): Promise<void>;
  renewCard(name: string, change: { cvv: string; publicFields: CreditCardPublicFields }): Promise<void>;
  patchCardPublic(name: string, patch: { label?: string | null; publicFields?: CreditCardPublicFields }): Promise<void>;
}

/** The mint-only surface injected into skills as the `secretCapture` capability.
 *  Deliberately excludes redeem/getMetadata so a skill can create a link but never read a value. */
export interface SecretCaptureMinter {
  mintUserSecret(args: MintNameArgs): Promise<MintResult>;
  mintSystemSecret(args: MintNameArgs): Promise<MintResult>;
  /** Record sign-in details on an already-stored `user.*` key without minting a link (#2201). */
  setUserSecretDetails(rawName: string, details: UserSecretDetails): Promise<{ secretName: string }>;
  /** Edit a saved card's label, expiry, cardholder name or billing postal code without a link (#1358).
   *  Validates; never takes a number or security code. */
  setUserCardPublic(rawName: string, edit: CardPublicEdit): Promise<{ secretName: string }>;
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
  /** Base64 delegate resume_token (#995). Present only when a delegated specialist minted the
   *  link; carries no secret value. Lets the redeem endpoint thread it onto secret.captured so
   *  the coordinator can re-delegate to the specialist. */
  resumeToken?: string;
}

export interface MintNameArgs {
  /** Raw, unresolved name from the skill input. Resolution depends on the policy. */
  rawName: string;
  label?: string;
  valueFormat?: CaptureValueFormat;
  /** Origin routing context (#972), persisted so redeem can re-enter the agent. Optional. */
  origin?: CaptureOrigin;
  /** Non-secret sign-in details stored with a user.* key (#2201). Ignored for system secrets. */
  details?: UserSecretDetails;
  /** Card form template (#1358). Forces json; user.* keys only. */
  template?: CaptureTemplate;
  /** True when `label` was derived from the name, not given by the caller. A derived label
   *  never replaces the label of a card that is already saved. */
  labelDerived?: boolean;
  // NOTE: TTL is intentionally NOT caller-controlled. The lifetime is a fixed security
  // property of the feature (single-use + 30 min, per #971), so callers cannot mint links
  // that are already dead, absurdly long-lived, or NaN. See DEFAULT_CAPTURE_TTL_MINUTES.
}

export interface MintResult {
  rawToken: string;
  /** The fully resolved vault key the value will be written to. */
  secretName: string;
  expiresAt: Date;
  /** True when mint bound the token to an already-stored `user.*` key (#1497). */
  reusedExisting?: boolean;
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
export type RedeemStatus = 'ok' | 'expired' | 'not_found' | 'invalid_json' | 'invalid_shape';

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
  resumeToken?: string;
}

/**
 * Outcome of a redeem attempt. On 'ok' it carries the captured routing context; every other
 * status carries nothing. Only a real (winning) claim returns 'ok' with context, so a replayed
 * redeem of an already-consumed token returns 'expired' and the route publishes no event —
 * exactly one secret.captured per capture.
 */
export type RedeemOutcome =
  | { status: 'ok'; captured: CapturedContext }
  | { status: 'expired' | 'not_found' | 'invalid_json' }
  // The submission did not fit the link: a card that failed validation (reason set), or a value
  // posted to a card link or a card posted to a plain one (no reason). The token is left unspent.
  | { status: 'invalid_shape'; reason?: CardValidationReason };

/** Non-secret summary of the card a renewal link is for. */
export interface CaptureCardSummary {
  brand: CardBrand;
  last4: string;
  label: string | null;
}

export type CaptureMetadata =
  | {
      label: string | null;
      valueFormat: CaptureValueFormat;
      captureTemplate?: CaptureTemplate | null;
      /** Present for a renewal link whose card still exists. */
      card?: CaptureCardSummary;
    }
  | 'expired'
  | 'not_found';

/** The row a winning claim returns. */
interface ClaimedToken {
  secret_name: string;
  value_format: CaptureValueFormat;
  label: string | null;
  conversation_id: string | null;
  channel_id: string | null;
  agent_id: string | null;
  task_event_id: string | null;
  originator: Record<string, unknown> | null;
  resume_intent: string | null;
  resume_token: string | null;
}

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
  private async mint(
    secretName: string,
    label: string | undefined,
    valueFormat: CaptureValueFormat,
    origin?: CaptureOrigin,
    template?: CaptureTemplate,
  ): Promise<{ rawToken: string; expiresAt: Date }> {
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
          conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent, resume_token,
          capture_template)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING expires_at`,
      [
        tokenHash, secretName, label ?? null, valueFormat, DEFAULT_CAPTURE_TTL_MINUTES,
        origin?.conversationId ?? null,
        origin?.channelId ?? null,
        origin?.agentId ?? null,
        origin?.taskEventId ?? null,
        origin?.originator ?? null,
        origin?.resumeIntent ?? null,
        origin?.resumeToken ?? null,
        template ?? null,
      ],
    );
    return { rawToken, expiresAt: result.rows[0]!.expires_at };
  }

  async mintUserSecret(args: MintNameArgs): Promise<MintResult> {
    const existing = await this.secrets.listUserNames();
    const secretName = resolveUserSecretName(args.rawName, existing);
    const reusedExisting = existing.includes(secretName);

    let label = args.label;
    if (args.template) {
      if (label !== undefined && normalizeCardLabel(label) === null) {
        throw new Error('The card label must be 1 to 100 characters.');
      }
      if (args.template === 'credit_card_renewal') {
        const card = await this.secrets.getCardPublic(secretName);
        if (!card) {
          throw new Error(
            `No saved card named '${args.rawName}'. Call list-user-secrets for the exact key, ` +
            'or use template credit_card to save a new card.',
          );
        }
        label = card.label ?? undefined;
      } else if (reusedExisting) {
        const card = await this.secrets.getCardPublic(secretName);
        if (!card) {
          throw new Error(
            `'${secretName}' is already stored and is not a saved card, so a card cannot be captured over it. ` +
            'Use a different secret_name for the card.',
          );
        }
        // Re-capturing a saved card keeps the principal's label unless one was given explicitly.
        if (args.labelDerived || label === undefined) label = card.label ?? undefined;
      }
    }
    if (!args.template && reusedExisting && await this.secrets.getCardPublic(secretName) !== null) {
      // A plain link would overwrite the saved card's encrypted document with a string.
      throw new Error(
        `\`${secretName}\` is a saved card — use template credit_card_renewal, or details_only for its details.`,
      );
    }
    // A card link is always json: the form posts card fields, never a free-form value.
    const valueFormat: CaptureValueFormat = args.template ? 'json' : (args.valueFormat ?? 'string');
    const { rawToken, expiresAt } = await this.mint(secretName, label, valueFormat, args.origin, args.template);
    if (args.details && hasUserSecretDetails(args.details)) {
      await this.secrets.upsertUserDetails(secretName, args.details);
    }
    return { rawToken, secretName, expiresAt, reusedExisting };
  }

  async setUserSecretDetails(rawName: string, details: UserSecretDetails): Promise<{ secretName: string }> {
    if (!hasUserSecretDetails(details)) throw new Error('Give login_url, username, or both.');
    const existing = await this.secrets.listUserNames();
    const secretName = resolveUserSecretName(rawName, existing);
    if (!existing.includes(secretName)) {
      throw new Error(
        `No stored secret matches '${rawName}'. Call list-user-secrets for the exact key, ` +
        'or mint a capture link with these details instead.',
      );
    }
    await this.secrets.upsertUserDetails(secretName, details);
    return { secretName };
  }

  async setUserCardPublic(rawName: string, edit: CardPublicEdit): Promise<{ secretName: string }> {
    const existing = await this.secrets.listUserNames();
    const secretName = resolveUserSecretName(rawName, existing);
    const current = existing.includes(secretName) ? await this.secrets.getCardPublic(secretName) : null;
    if (!current) {
      throw new Error(`No saved card named '${rawName}'. Call list-user-secrets for the exact key.`);
    }

    let label: string | undefined;
    if (edit.label !== undefined) {
      const normalized = normalizeCardLabel(edit.label);
      if (normalized === null) throw new Error('The card label must be 1 to 100 characters.');
      label = normalized;
    }
    const touchesPublic = edit.expiry_month !== undefined || edit.expiry_year !== undefined
      || edit.cardholder_name !== undefined || edit.billing_zip !== undefined;
    if (label === undefined && !touchesPublic) {
      throw new Error('Give a card_label, expiry_month, expiry_year, cardholder_name, or billing_zip to change.');
    }

    let publicFields: CreditCardPublicFields | undefined;
    if (touchesPublic) {
      const checked = validateCardPublicPatch(edit, current.publicFields);
      if (!checked.ok) throw new Error(CARD_VALIDATION_MESSAGES[checked.reason]);
      publicFields = checked.publicFields;
    }
    await this.secrets.patchCardPublic(secretName, {
      ...(label !== undefined ? { label } : {}),
      ...(publicFields ? { publicFields } : {}),
    });
    return { secretName };
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
      capture_template: CaptureTemplate | null;
      secret_name: string;
      spent: boolean;
    }>(
      `SELECT label, value_format, capture_template, secret_name,
              (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [hashToken(rawToken)],
    );
    const row = res.rows[0];
    if (!row) return 'not_found';
    if (row.spent) return 'expired';
    if (!row.capture_template) return { label: row.label, valueFormat: row.value_format };
    // The summary is public fields only, and the vault key itself is never returned.
    const card = row.capture_template === 'credit_card_renewal'
      ? await this.secrets.getCardPublic(row.secret_name)
      : null;
    return {
      label: row.label,
      valueFormat: row.value_format,
      captureTemplate: row.capture_template,
      ...(card ? { card: { brand: card.publicFields.brand, last4: card.publicFields.last4, label: card.label } } : {}),
    };
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
      capture_template: CaptureTemplate | null;
      spent: boolean;
    }>(
      `SELECT value_format, capture_template,
              (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = peek.rows[0];
    if (!row) return { status: 'not_found' };
    if (row.spent) return { status: 'expired' };
    // A card link takes card fields through redeemCard, which validates them. A raw value
    // here would bypass that and store arbitrary JSON as a card.
    if (row.capture_template) return { status: 'invalid_shape' };

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

    return this.claimAndWrite(tokenHash, async claimed => {
      if (claimed.value_format === 'json') {
        await this.secrets.setJSON(claimed.secret_name, parsed);
      } else {
        await this.secrets.set(claimed.secret_name, value);
      }
    });
  }

  /**
   * Redeem a card link (#1358): validate the submitted card fields, then claim the token and
   * write. Validation runs BEFORE the claim, so a typo does not burn the single-use token.
   *
   *  - `credit_card` takes the full card (number, security code, expiry, name, optional ZIP).
   *  - `credit_card_renewal` takes `cvv`, `expiry_month` and `expiry_year`, checks them against
   *    the stored brand and current expiry, and writes the new code and expiry in one transaction.
   * A token without a card template refuses a card (`invalid_shape`, no reason).
   */
  async redeemCard(rawToken: string, card: Record<string, unknown>): Promise<RedeemOutcome> {
    const tokenHash = hashToken(rawToken);
    const peek = await this.pool.query<{
      capture_template: CaptureTemplate | null;
      secret_name: string;
      spent: boolean;
    }>(
      `SELECT capture_template, secret_name,
              (consumed_at IS NOT NULL OR expires_at <= now()) AS spent
         FROM secret_capture_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = peek.rows[0];
    if (!row) return { status: 'not_found' };
    if (row.spent) return { status: 'expired' };
    if (!row.capture_template) return { status: 'invalid_shape' };

    if (row.capture_template === 'credit_card') {
      const checked = validateCreditCard({
        number: card.number,
        cvv: card.cvv,
        expiry_month: card.expiry_month,
        expiry_year: card.expiry_year,
        cardholder_name: card.cardholder_name,
        billing_zip: card.billing_zip,
      });
      if (!checked.ok) return this.cardRefused(checked.reason);
      return this.claimAndWrite(tokenHash, claimed =>
        this.secrets.setCard(claimed.secret_name, checked.secret, checked.publicFields, claimed.label));
    }

    // Renewal. Both expiry parts are required: the form always sends them, and a missing one
    // would otherwise validate as "no change" and renew nothing.
    const current = await this.secrets.getCardPublic(row.secret_name);
    if (!current) {
      this.options.logger?.warn('secret-capture: renewal link redeemed but the card no longer exists');
      // Not 'not_found': the link is live, so the page must not say it was never valid.
      return this.cardRefused('card_missing');
    }
    if (card.expiry_month === undefined || card.expiry_year === undefined) return this.cardRefused('expiry_format');
    const expiry = validateCardPublicPatch(
      { expiry_month: card.expiry_month, expiry_year: card.expiry_year },
      current.publicFields,
    );
    if (!expiry.ok) return this.cardRefused(expiry.reason);
    if (!validateCvv(card.cvv, current.publicFields.brand)) return this.cardRefused('cvv_format');
    const cvv = card.cvv as string; // validateCvv confirmed it is a string
    return this.claimAndWrite(tokenHash, claimed =>
      this.secrets.renewCard(claimed.secret_name, { cvv, publicFields: expiry.publicFields }));
  }

  private cardRefused(reason: CardValidationReason): RedeemOutcome {
    // The reason is a category, never the offending value.
    this.options.logger?.warn({ reason }, 'secret-capture: card submission refused — token left unspent for retry');
    return { status: 'invalid_shape', reason };
  }

  /**
   * Atomically claim a token and run the vault write for it. The claim is the single-use
   * guard; `write` runs only for the winner. Shared by redeem and redeemCard.
   */
  private async claimAndWrite(
    tokenHash: string,
    write: (claimed: ClaimedToken) => Promise<void>,
  ): Promise<RedeemOutcome> {
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
    const claim = await this.pool.query<ClaimedToken>(
      `UPDATE secret_capture_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING secret_name, value_format, label,
                  conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent, resume_token`,
      [tokenHash],
    );
    const claimed = claim.rows[0];
    if (!claimed) return { status: 'expired' };

    try {
      await write(claimed);
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
        resumeToken: claimed.resume_token ?? undefined,
      },
    };
  }
}
