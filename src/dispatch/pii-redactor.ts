// pii-redactor.ts — channel-aware PII redactor for outbound messages.
//
// Sits between the agent response and the channel adapter. For each outbound
// message it:
//   1. Checks whether the kill switch is active (enabled: false → pass through)
//   2. Checks trust override — CEO and other overridden levels bypass entirely (silent)
//   3. Detects PII using the shared detectPii() core from src/pii/scrubber.ts
//   4. Filters matches to those not in the channel's allow list
//   5. Replaces them end-to-start with labelled tokens (e.g. [REDACTED: CREDIT_CARD])
//   6. Fires an audit bus event (fire-and-forget with .catch(warn))
//
// Fail-closed: this class does NOT swallow its own errors. The caller (OutboundGateway
// in Task 8) is responsible for catching and deciding whether to block delivery.

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { TrustLevel } from '../contacts/types.js';
import { meetsMinimumTrust, TRUST_RANK } from '../contacts/types.js';
import type { PiiPattern } from '../pii/scrubber.js';
import { detectPii } from '../pii/scrubber.js';
import { createOutboundPiiRedacted } from '../bus/events.js';

// -- Config shape (mirrors the outbound_redaction block from YamlConfig) --

export interface OutboundRedactionConfig {
  /** Kill switch. When false, all redaction is bypassed. */
  enabled: boolean;
  /** Trust level strings that bypass redaction entirely (e.g. ['ceo']). */
  trust_override: string[];
  /** Default action for channels / patterns not in channel_policies. */
  default: 'block' | 'allow';
  /** Per-channel policy: labels listed here are allowed through unredacted. */
  channel_policies: Record<string, { allow: string[] }>;
}

// -- Public result types --

/**
 * A single redaction that was applied to the message.
 * Intentionally does NOT store the original matched value — only what it was replaced with.
 */
export interface RedactionEntry {
  /** Pattern label in lowercase (e.g. "credit_card", "email"). */
  patternLabel: string;
  /** Channel the message was routed through. */
  channelId: string;
  /** The replacement token that was inserted (e.g. "[REDACTED: CREDIT_CARD]"). */
  replacedWith: string;
}

/** Result of a redact() call. */
export interface RedactionResult {
  /** The content with PII replaced (or the original if nothing was redacted). */
  content: string;
  /** List of applied redactions. Empty when nothing was redacted. */
  redactions: RedactionEntry[];
}

// -- Constructor options --

export interface PiiRedactorOptions {
  config: OutboundRedactionConfig;
  bus: EventBus;
  logger: Logger;
  /** Extra patterns from config (loaded once at startup and threaded through). */
  extraPatterns: PiiPattern[];
  /**
   * The CEO's contact UUID, resolved from ceoPrimaryEmail at startup by bootstrapCeoContact().
   * When set, any message destined for this exact contact ID bypasses PII redaction entirely,
   * regardless of trust_level. This is the primary CEO identification mechanism — more stable
   * than trust_level because it is an immutable UUID resolved once at startup, not a DB field
   * that could be accidentally updated by contact-management code paths.
   */
  ceoContactId?: string;
}

// -- Optional context for audit event --

export interface RedactContext {
  conversationId?: string;
  recipientId?: string;
  parentEventId?: string;
  /**
   * The recipient's contact UUID (from the contacts table).
   * Used to bypass redaction when it matches PiiRedactorOptions.ceoContactId.
   */
  recipientContactId?: string;
}

// -- PiiRedactor class --

export class PiiRedactor {
  private readonly config: OutboundRedactionConfig;
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly extraPatterns: PiiPattern[];
  private readonly ceoContactId: string | undefined;

  constructor(opts: PiiRedactorOptions) {
    this.config = opts.config;
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.extraPatterns = opts.extraPatterns;
    this.ceoContactId = opts.ceoContactId;
  }

  /**
   * Redact PII from outbound content based on channel policy and trust level.
   *
   * Returns the (possibly modified) content and a list of applied redactions.
   * Returns the original content unchanged if:
   *   - redaction is disabled (kill switch)
   *   - the trust level meets or exceeds a configured trust_override level
   *   - no PII is detected
   *   - all detected PII is in the channel's allow list
   *
   * @param content    The outbound message content.
   * @param channelId  The destination channel (e.g. 'email', 'signal').
   * @param trustLevel The resolved trust level of the recipient (null = untrusted).
   * @param context    Optional metadata for the audit bus event.
   */
  async redact(
    content: string,
    channelId: string,
    trustLevel: TrustLevel | null,
    context: RedactContext = {},
  ): Promise<RedactionResult> {
    // Step 1: Kill switch — if disabled, pass through without any inspection.
    if (!this.config.enabled) {
      return { content, redactions: [] };
    }

    // Step 1b: CEO contact ID bypass — more reliable than trust_level.
    // The CEO contact UUID is resolved once from ceoPrimaryEmail at startup and stored here.
    // A UUID match is tamper-proof: it cannot be accidentally elevated via contact management
    // code paths (unlike trust_level, which has a setTrustLevel() API).
    if (this.ceoContactId && context.recipientContactId === this.ceoContactId) {
      return { content, redactions: [] };
    }

    // Step 2: Trust override — certain trust levels (typically 'ceo') bypass
    // redaction entirely. We use meetsMinimumTrust() so that a recipient with
    // 'ceo' trust also satisfies 'high', 'medium', and 'low' overrides.
    for (const overrideLevel of this.config.trust_override) {
      // Guard against typos or invalid values from programmatic config construction
      // (JSON schema validates YAML, but not runtime-constructed configs).
      if (!(overrideLevel in TRUST_RANK)) {
        this.logger.warn(
          { unknownOverrideLevel: overrideLevel },
          'pii-redactor: unknown trust_override level in config — entry ignored',
        );
        continue;
      }
      if (meetsMinimumTrust(trustLevel, overrideLevel as TrustLevel)) {
        return { content, redactions: [] };
      }
    }

    // Step 3: Detect PII using the shared scrubber core.
    const matches = detectPii(content, this.extraPatterns);
    if (matches.length === 0) {
      return { content, redactions: [] };
    }

    // Step 4: Build the allow set for this channel (lowercase comparison).
    // If the channel is not in channel_policies, fall back to the default action.
    const channelPolicy = this.config.channel_policies[channelId];
    const allowSet = new Set(
      (channelPolicy?.allow ?? []).map((label) => label.toLowerCase()),
    );

    // If default is 'allow' and the channel has no explicit policy, everything is allowed.
    // If default is 'block' and the channel has no explicit policy, all PII is blocked.
    // Filter to matches that are NOT in the allow set.
    const toRedact = matches.filter((m) => {
      const label = m.label.toLowerCase();
      if (allowSet.has(label)) {
        // Explicitly allowed on this channel — pass through.
        return false;
      }
      // Not in the allow list — check the default action.
      // 'block' → redact; 'allow' → pass (but only for channels without an explicit policy).
      if (!channelPolicy && this.config.default === 'allow') {
        return false;
      }
      return true;
    });

    if (toRedact.length === 0) {
      return { content, redactions: [] };
    }

    // Step 5: Apply replacements end-to-start so earlier indices remain valid
    // as the string length changes with each substitution.
    let redacted = content;
    const redactions: RedactionEntry[] = [];

    for (let i = toRedact.length - 1; i >= 0; i--) {
      const match = toRedact[i]!;
      const replacedWith = `[REDACTED: ${match.label.toUpperCase()}]`;
      redacted = redacted.slice(0, match.start) + replacedWith + redacted.slice(match.end);
      // Build entry without the original matched value — intentional PII-safety design.
      redactions.unshift({
        patternLabel: match.label.toLowerCase(),
        channelId,
        replacedWith,
      });
    }

    // Step 6: Log the redaction event.
    this.logger.info(
      {
        event: 'pii_redacted',
        channelId,
        redactionCount: redactions.length,
        patternLabels: redactions.map((r) => r.patternLabel),
        conversationId: context.conversationId,
      },
      'PII redacted from outbound message',
    );

    // Step 7: Publish audit bus event — fire-and-forget. We do not await
    // because a bus failure must not block delivery of the redacted message.
    // Errors are caught and logged at warn level (not error) since the message
    // was already cleaned — audit lag is bad but not a delivery failure.
    this.bus.publish('dispatch', createOutboundPiiRedacted({
      channelId,
      recipientId: context.recipientId ?? '',
      conversationId: context.conversationId ?? '',
      redactions: redactions.map((r) => ({
        patternLabel: r.patternLabel,
        replacedWith: r.replacedWith,
      })),
      parentEventId: context.parentEventId,
    })).catch((err: unknown) => {
      this.logger.warn(
        { err, event: 'pii_redacted_bus_publish_failed', channelId },
        'Failed to publish outbound.pii-redacted audit event',
      );
    });

    return { content: redacted, redactions };
  }
}
