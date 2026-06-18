// outbound-filter.ts — two-stage outbound content filter.
//
// Before any agent response is delivered to a recipient, it passes through
// this pipeline:
//   Stage 1: Deterministic rules (fast, no LLM call) — catches known bad patterns.
//   Stage 2: LLM review (contextual appropriateness) — catches subtle leakage.
//   Stage 2.5: Escalation judge (tier-sensitive disclosure gate) — classifies content
//     by disclosure class and checks it against the recipient's tier policy table.
//
// Security principle: each stage is an independent boundary. Stage 1 failures
// short-circuit immediately; Stages 2 and 2.5 only run on clean Stage 1 output.
//
// The secret patterns here are intentionally duplicated from src/skills/sanitize.ts.
// The outbound filter is a separate security boundary — sharing code would couple
// the two boundaries and risk one change silently weakening the other.

import type { ContactTier } from '../contacts/types.js';
import { meetsMinimumTier } from '../contacts/types.js';
import type { OutboundJudge, JudgeInput } from './outbound-judge.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';

/**
 * A single resolved outbound recipient. `isPrincipal` is determined structurally
 * (the recipient matches one of the principal's verified channel identities) —
 * never from the free-text contact `role` field.
 */
export interface FilterRecipient {
  email: string;
  isPrincipal: boolean;
}

export interface FilterCheckInput {
  content: string;
  recipientEmail: string;
  conversationId: string;
  channelId: string;
  // Tier of the recipient contact as resolved from the contact DB.
  // 'unknown' is the safe fallback when the contact is not found in the DB.
  // Governs the contact-data-leak rule (third-party email disclosure) and the
  // Stage 2.5 escalation-judge disclosure gate.
  recipientTier: ContactTier;
  /**
   * Full recipient set (To + CC), each tagged isPrincipal structurally. Used by
   * Stage 2 (LLM judge). Optional: when absent (legacy callers / Stage-1-only unit
   * tests), Stage 2 treats the message as NOT principal-sole and the judge — if
   * configured — runs over an empty recipient list.
   */
  recipients?: FilterRecipient[];
  principalIncluded?: boolean;
  principalIsSoleRecipient?: boolean;
}

export interface FilterFinding {
  rule: string;
  detail: string;
}

export interface FilterResult {
  passed: boolean;
  findings: FilterFinding[];
  // Stage is only set when the filter blocked the content.
  // Omitting stage on a pass avoids confusion ("which stage passed?")
  stage?: 'deterministic' | 'llm-review' | 'disclosure-gate';
}

export interface OutboundContentFilterConfig {
  // Phrases from the system prompt. If any appear in outbound content, it's
  // a signal the agent accidentally echoed its own instructions.
  systemPromptMarkers: string[];
  // CEO email — allowed in outbound content (not a third-party leak).
  ceoEmail: string;
  /** Optional Stage 2 LLM judge. When absent, Stage 2 is a no-op pass. */
  judge?: OutboundJudge;
  /**
   * Optional Stage 2.5 escalation judge. When present, classifies outbound content
   * by disclosure class and gates it against the recipient's tier policy. Catches
   * borderline disclosures (principal context to unknown recipients, confidential
   * content to untrusted recipients) that the deterministic Stage 1 rules miss.
   * When absent, Stage 2.5 is a no-op pass.
   */
  escalationJudge?: EscalationJudge;
}

// Bus event type names that should never appear in outbound messages.
// These are the dotted identifiers used internally on the event bus.
// Their presence in a response indicates the agent is leaking architecture details.
const BUS_EVENT_TYPE_NAMES: string[] = [
  'inbound.message',
  'agent.task',
  'agent.response',
  'outbound.message',
  'outbound.blocked',
  'outbound.notification',
  'skill.invoke',
  'skill.result',
  'memory.store',
  'memory.query',
  'contact.resolved',
  'contact.unknown',
  'message.held',
];

// Internal field names that are specific to this system's data model.
// These are checked only in "structured contexts" (quoted or colon-prefixed)
// to avoid false positives on common English words.
// E.g., "conversationId" should flag, but bare "agent" or "task" should not.
// Both camelCase and snake_case variants are included so the filter catches
// JSON leakage regardless of which serialization convention the agent uses.
const INTERNAL_FIELD_NAMES: string[] = [
  'sourceLayer',
  'source_layer',
  'systemPrompt',
  'system_prompt',
  'conversationId',
  'conversation_id',
  'senderId',
  'sender_id',
  'channelId',
  'channel_id',
  'taskId',
  'task_id',
  'agentId',
  'agent_id',
  'parentEventId',
  'parent_event_id',
  'eventType',
  'event_type',
  'skillName',
  'skill_name',
  'senderContext',
  'sender_context',
];

// Secret patterns — same as sanitize.ts but duplicated intentionally.
// These patterns cover the most common credential formats seen in the wild.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Bearer tokens — JWT pattern (three base64url segments separated by dots)
  /Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+/=]*/g,
  // Generic long hex tokens (32+ hex chars, word-boundary anchored)
  /(?<![a-zA-Z0-9])[a-f0-9]{32,}(?![a-zA-Z0-9])/g,
];

// Matches any RFC 5321-ish email address in a string.
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Normalize text for security matching by stripping zero-width and invisible
 * Unicode characters that could be used to evade pattern matching.
 * An LLM under prompt injection could be instructed to insert invisible
 * characters between words to break substring matching.
 */
function normalizeForMatching(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u2060-\u2064\u206A-\u206F]/g, '');
}

export class OutboundContentFilter {
  private config: OutboundContentFilterConfig;
  private judge?: OutboundJudge;
  private escalationJudge?: EscalationJudge;

  constructor(config: OutboundContentFilterConfig) {
    this.config = config;
    this.judge = config.judge;
    this.escalationJudge = config.escalationJudge;
  }

  /**
   * Run the filter pipeline on outbound content.
   *
   * Stage 1 collects ALL findings (not short-circuit per rule) so a single
   * blocked message can report all the reasons it was blocked — useful for
   * debugging and audit logging.
   *
   * Stage 2 only runs if Stage 1 finds nothing. This avoids wasting LLM
   * resources on content that is already deterministically blocked.
   *
   * Stage 2.5 only runs if Stages 1 and 2 both pass. The escalation judge
   * classifies the content's disclosure class and enforces the tier policy table.
   */
  async check(input: FilterCheckInput): Promise<FilterResult> {
    // Normalize first to strip invisible Unicode characters that an adversarial
    // LLM could insert to break substring matching (e.g., zero-width spaces
    // between letters). All deterministic checks run on the normalized copy.
    const normalizedContent = normalizeForMatching(input.content);

    // Stage 1: deterministic rules
    const findings: FilterFinding[] = [
      ...this.checkSystemPromptFragments(normalizedContent),
      ...this.checkInternalStructure(normalizedContent),
      ...this.checkSecretPatterns(normalizedContent),
      ...this.checkContactDataLeak(normalizedContent, input.recipientEmail, input.recipientTier),
    ];

    if (findings.length > 0) {
      return { passed: false, findings, stage: 'deterministic' };
    }

    // Stage 2: LLM judge review (audience-leak). No-op pass when no judge is configured.
    // Fail-closed: if the LLM review crashes, block the message rather than
    // silently passing it. This is a security boundary.
    let llmFindings: FilterFinding[] = [];
    try {
      llmFindings = await this.runLlmReview({ ...input, content: normalizedContent });
    } catch (err) {
      // Fail-closed: if the LLM review crashes, block the message.
      const message = err instanceof Error ? err.message : String(err);
      llmFindings = [{ rule: 'llm-review-error', detail: `LLM review threw: ${message}` }];
    }
    if (llmFindings.length > 0) {
      return { passed: false, findings: llmFindings, stage: 'llm-review' };
    }

    // Stage 2.5: escalation judge — tier-sensitive disclosure gate.
    // Classifies the content's disclosure class (public, principal-context, third-party,
    // confidential) and checks it against the tier's allowed set in DISCLOSURE_ALLOWED.
    // Catches borderline disclosures (e.g. CEO availability shared with an 'unknown'
    // recipient) that the deterministic email-pattern scan in Stage 1 misses.
    // No-op pass when no escalation judge is configured.
    let escalationFindings: FilterFinding[] = [];
    try {
      escalationFindings = await this.runEscalationJudge({ ...input, content: normalizedContent });
    } catch (err) {
      // Fail-closed: disclosure gate error blocks the message.
      const message = err instanceof Error ? err.message : String(err);
      escalationFindings = [{ rule: 'disclosure-gate-error', detail: `Escalation judge threw: ${message}` }];
    }
    if (escalationFindings.length > 0) {
      return { passed: false, findings: escalationFindings, stage: 'disclosure-gate' };
    }

    // All stages passed — no stage field on success
    return { passed: true, findings: [] };
  }

  // Stage 1 rules

  /**
   * Rule: system-prompt-fragment
   *
   * Checks if any configured marker phrase appears in the content.
   * Case-insensitive — the agent might reproduce markers in any casing.
   */
  private checkSystemPromptFragments(content: string): FilterFinding[] {
    const findings: FilterFinding[] = [];
    const lower = content.toLowerCase();

    for (const marker of this.config.systemPromptMarkers) {
      if (lower.includes(marker.toLowerCase())) {
        findings.push({
          rule: 'system-prompt-fragment',
          detail: `Content contains system prompt marker: "${marker}"`,
        });
      }
    }

    return findings;
  }

  /**
   * Rule: internal-structure
   *
   * Two sub-checks:
   * 1. Bus event type names (dotted identifiers like "inbound.message") —
   *    these only appear in internal event bus traffic, never in user-facing prose.
   * 2. Internal field names in structured contexts (quoted or colon-prefixed) —
   *    e.g., "conversationId" or channelId: — indicating JSON/object leakage.
   *    The structured-context restriction avoids false positives on bare words
   *    like "agent" that have legitimate uses in English.
   */
  private checkInternalStructure(content: string): FilterFinding[] {
    const findings: FilterFinding[] = [];
    // Lowercase once for the bus event type sub-check; the BUS_EVENT_TYPE_NAMES
    // are already lowercase so a single toLower on content is sufficient.
    const lowerContent = content.toLowerCase();

    // Sub-check 1: bus event type names (dotted identifiers)
    for (const eventType of BUS_EVENT_TYPE_NAMES) {
      if (lowerContent.includes(eventType)) {
        findings.push({
          rule: 'internal-structure',
          detail: `Content contains internal bus event type name: "${eventType}"`,
        });
        // One finding per sub-check is enough; stop after first match to
        // avoid flooding the findings list with repeated bus type matches
        break;
      }
    }

    // Sub-check 2: internal field names in structured contexts
    for (const fieldName of INTERNAL_FIELD_NAMES) {
      // Match: "fieldName" or 'fieldName' (JSON key) OR fieldName: (YAML/object key)
      // The \s* allows optional whitespace before the colon.
      const pattern = new RegExp(
        `["']${fieldName}["']|\\b${fieldName}\\s*:`,
      );
      if (pattern.test(content)) {
        findings.push({
          rule: 'internal-structure',
          detail: `Content contains internal field name in structured context: "${fieldName}"`,
        });
        break; // One finding is sufficient; the caller knows the content is suspect
      }
    }

    return findings;
  }

  /**
   * Rule: secret-pattern
   *
   * Detects common credential formats: API keys, Bearer tokens, hex tokens.
   * Patterns are reset before each use (global regexes maintain lastIndex state).
   */
  private checkSecretPatterns(content: string): FilterFinding[] {
    const findings: FilterFinding[] = [];

    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex — global regexes are stateful and will miss matches
      // if lastIndex is non-zero from a previous call to the same regex object.
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        findings.push({
          rule: 'secret-pattern',
          detail: `Content matches secret pattern: ${pattern.source.slice(0, 40)}`,
        });
        // Reset again after test() so subsequent calls on the same pattern work
        pattern.lastIndex = 0;
      }
    }

    return findings;
  }

  /**
   * Rule: contact-data-leak
   *
   * Finds any email address in the content that is not the recipient or CEO,
   * then decides whether to block based on recipient tier.
   *
   * Block condition:
   *   third-party email present AND recipient tier < 'trusted'
   *
   * Allow condition:
   *   no third-party email OR recipient tier >= 'trusted'
   *
   * 'trusted' and 'principal' tiers may receive third-party contact data
   * (emails of other people). This covers both "CEO asked for Hamilton's email"
   * and "daily briefing lists meeting attendees". Tiers below 'trusted' never
   * receive third-party contact data.
   *
   * Note: when the recipient is not in the contacts DB, the gateway passes
   * tier='unknown', which correctly restricts third-party disclosure.
   */
  private checkContactDataLeak(
    content: string,
    recipientEmail: string,
    recipientTier: ContactTier,
  ): FilterFinding[] {
    // Only add ceoEmail if it is actually configured — an empty string (missing
    // CEO_PRIMARY_EMAIL env var) would be a no-op entry that never matches but
    // obscures the fact that the config is incomplete.
    const allowedEmails = new Set([
      recipientEmail.toLowerCase(),
      ...(this.config.ceoEmail ? [this.config.ceoEmail.toLowerCase()] : []),
    ]);

    // Recipients at 'trusted' or above may receive third-party email addresses.
    // meetsMinimumTier throws on unrecognized tiers — this is intentional; an
    // unrecognized tier is a programming error and should fail loudly at the gate.
    const recipientIsTrusted = meetsMinimumTier(recipientTier, 'trusted');

    // Trusted recipient: allow third-party emails in content without scanning.
    if (recipientIsTrusted) {
      return [];
    }

    // Untrusted recipient: scan for third-party emails and block any that appear.
    // The allowedEmails set still permits the recipient and CEO email addresses to
    // appear in content without triggering a finding.
    const findings: FilterFinding[] = [];
    const seen = new Set<string>();

    EMAIL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EMAIL_REGEX.exec(content)) !== null) {
      const email = match[0].toLowerCase();
      if (!allowedEmails.has(email) && !seen.has(email)) {
        seen.add(email);
        findings.push({
          rule: 'contact-data-leak',
          detail: `Content contains third-party email address: "${match[0]}"`,
        });
      }
    }

    return findings;
  }

  // Stage 2: LLM review

  /**
   * Stage 2: delegate to the configured OutboundJudge (LLM-as-judge).
   *
   * When a judge is injected, it reviews the (already Stage-1-clean, normalized)
   * outbound content for audience leaks — internal monologue / system status /
   * side-channel notes sent to a mixed audience — and returns findings ([] = pass).
   * When no judge is configured, Stage 2 is a no-op pass.
   *
   * The judge owns its own timeout, verdict parsing, and failure semantics
   * (split fail-open/closed) and never throws; see outbound-judge.ts. The caller
   * (check()) still wraps this in a try/catch as a last-resort net.
   *
   * Trust-boundary note: the judge sends outbound content to its configured model
   * provider for review. Operators choosing a hosted provider should select a model
   * whose data-handling posture they accept; a different vendor than the agent tiers
   * is recommended for review diversity (see filter.llmJudge config).
   */
  private async runLlmReview(input: FilterCheckInput): Promise<FilterFinding[]> {
    // No judge configured → Stage 2 is a no-op pass (preserves prior behavior).
    if (!this.judge) return [];

    const judgeInput: JudgeInput = {
      content: input.content,
      recipients: input.recipients ?? [],
      principalIncluded: input.principalIncluded ?? false,
      principalIsSoleRecipient: input.principalIsSoleRecipient ?? false,
      conversationId: input.conversationId,
      channelId: input.channelId,
    };
    // The judge owns its own failure semantics (split fail-open/closed) and never
    // throws. The try/catch around runLlmReview in check() remains as a last-resort
    // net for truly unexpected throws.
    return this.judge.review(judgeInput);
  }

  // Stage 2.5: escalation judge (tier-sensitive disclosure gate)

  /**
   * Stage 2.5: delegate to the configured EscalationJudge.
   *
   * The escalation judge classifies the content's disclosure sensitivity
   * (public / principal-context / third-party / confidential) and applies the
   * DISCLOSURE_ALLOWED policy table to determine if that class is permitted for
   * the recipient's tier. This catches borderline disclosures that the deterministic
   * Stage 1 rules miss — e.g. the CEO's availability being shared with an 'unknown'
   * external recipient.
   *
   * When no escalation judge is configured, Stage 2.5 is a no-op pass.
   *
   * Fail-closed: the EscalationJudge is designed to never throw and returns
   * decision='escalate' on any LLM failure (timeout, malformed verdict, provider
   * error). The outer try/catch in check() handles any truly unexpected throws.
   */
  private async runEscalationJudge(input: FilterCheckInput): Promise<FilterFinding[]> {
    // Treat a disabled judge the same as an absent one — both are a no-op pass.
    // A disabled judge is an operator kill switch; we don't want it hard-blocking
    // every message (which is what classifyDisclosure returns when enabled=false).
    if (!this.escalationJudge || !this.escalationJudge.isEnabled()) return [];

    const verdict = await this.escalationJudge.classifyDisclosure({
      content: input.content,
      recipientTier: input.recipientTier,
      conversationId: input.conversationId,
    });

    if (verdict.decision === 'escalate') {
      // Detail uses only deterministic enum values (class + tier), not verdict.reason.
      // The LLM-generated reason is available in structured logs from the judge's own
      // logger but must not be forwarded to the CEO notification email — the disclosure
      // judge prompt does not explicitly prohibit quoting from the evaluated content,
      // so verdict.reason could theoretically echo sensitive fragments.
      return [{
        rule: 'disclosure-tier-gate',
        detail: `Disclosure class '${verdict.disclosureClass ?? 'unknown'}' not permitted for tier '${input.recipientTier}'`,
      }];
    }

    return [];
  }
}
