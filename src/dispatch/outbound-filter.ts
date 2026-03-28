// outbound-filter.ts — two-stage outbound content filter.
//
// Before any agent response is delivered to a recipient, it passes through
// this pipeline:
//   Stage 1: Deterministic rules (fast, no LLM call) — catches known bad patterns.
//   Stage 2: LLM review (contextual appropriateness) — catches subtle leakage.
//
// Security principle: each stage is an independent boundary. Stage 1 failures
// short-circuit immediately; Stage 2 only runs on clean Stage 1 output.
//
// The secret patterns here are intentionally duplicated from src/skills/sanitize.ts.
// The outbound filter is a separate security boundary — sharing code would couple
// the two boundaries and risk one change silently weakening the other.

export interface FilterCheckInput {
  content: string;
  recipientEmail: string;
  conversationId: string;
  channelId: string;
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
  stage?: 'deterministic' | 'llm-review';
}

export interface OutboundContentFilterConfig {
  // Phrases from the system prompt. If any appear in outbound content, it's
  // a signal the agent accidentally echoed its own instructions.
  systemPromptMarkers: string[];
  // CEO email — allowed in outbound content (not a third-party leak).
  ceoEmail: string;
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

  constructor(config: OutboundContentFilterConfig) {
    this.config = config;
  }

  /**
   * Run the two-stage filter pipeline on outbound content.
   *
   * Stage 1 collects ALL findings (not short-circuit per rule) so a single
   * blocked message can report all the reasons it was blocked — useful for
   * debugging and audit logging.
   *
   * Stage 2 only runs if Stage 1 finds nothing. This avoids wasting LLM
   * resources on content that is already deterministically blocked.
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
      ...this.checkContactDataLeak(normalizedContent, input.recipientEmail),
    ];

    if (findings.length > 0) {
      return { passed: false, findings, stage: 'deterministic' };
    }

    // Stage 2: LLM review (stub — always passes for now)
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

    // Both stages passed — no stage field on success
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
   * Finds any email address in the content that is not the recipient or CEO.
   * Third-party emails appearing in outbound messages risk leaking contacts
   * from the CEO's address book to unintended recipients.
   */
  private checkContactDataLeak(content: string, recipientEmail: string): FilterFinding[] {
    const findings: FilterFinding[] = [];
    const allowedEmails = new Set([
      recipientEmail.toLowerCase(),
      this.config.ceoEmail.toLowerCase(),
    ]);

    // Reset regex before use (global regex maintains lastIndex state between calls)
    EMAIL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

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
   * Run an LLM-based review of the content for contextual appropriateness.
   *
   * @TODO (future): Replace stub with a locally-hosted open-source model
   * (e.g., Mistral 7B or Llama 3) that is intentionally different from the
   * primary coordinator LLM. Using a different model avoids the risk that
   * both stages are fooled by the same adversarial prompt. The model should
   * evaluate: tone appropriateness, accidental information disclosure,
   * hallucinated facts, and context-specific policy violations.
   *
   * The local hosting requirement is a deliberate design choice: we do not
   * want outbound content (which may be sensitive) leaving the trust boundary
   * to reach an external API just for a safety check.
   */
  private async runLlmReview(_input: FilterCheckInput): Promise<FilterFinding[]> {
    // Stub: always passes. LLM review not yet implemented.
    return [];
  }
}
