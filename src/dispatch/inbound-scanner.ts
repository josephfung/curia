// inbound-scanner.ts — Layer 1 prompt injection detection for the dispatch layer.
//
// Runs on every inbound message before it reaches the Coordinator's LLM.
// Two responsibilities:
//   1. Strip instruction-mimicking XML/HTML markup from message content.
//   2. Detect instruction-like phrases and score the message's risk.
//
// Flagged messages are NOT blocked — they pass through with a risk_score in the
// agent.task event metadata. The Coordinator's system prompt (Layer 2) instructs
// it how to handle elevated scores. Blocking is reserved for future policy config.
//
// Spec: docs/specs/06-audit-and-security.md — Prompt Injection Defense → Layer 1

// XML/HTML tags that mimic system prompt structures. Stripped from content before
// any downstream consumer (LLM or subscriber) sees the message. We strip both the
// paired form (<system>...</system>) and orphan tags (<system />, </system>).
//
// The `context` and `user` tags are added here beyond the sanitize.ts set because
// they appear in common prompt injection templates that attempt to override the
// conversation role structure.
const INSTRUCTION_TAG_PAIR_PATTERN =
  /<(system|instructions?|prompt|context|assistant|user)[\s>][\s\S]*?<\/\1>/gi;

const INSTRUCTION_TAG_ORPHAN_PATTERN =
  /<\/?(system|instructions?|prompt|context|assistant|user)[^>]*>/gi;

// Default injection pattern list from the spec.
// Each entry is a [regex, human-readable label] pair.
// The regex is the detection rule; the label appears in findings for audit readability.
//
// Patterns are intentionally case-insensitive (flag `i`) and use \s+ to tolerate
// whitespace variations that an adversary might insert to break naive string matching.
const DEFAULT_INJECTION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /ignore\s+previous\s+instructions?/i, label: 'ignore previous instructions' },
  { regex: /ignore\s+all\s+prior\s+instructions?/i, label: 'ignore all prior instructions' },
  { regex: /you\s+are\s+now\b/i, label: 'you are now' },
  { regex: /\bsystem\s*:/i, label: 'system:' },
  { regex: /\[system\]/i, label: '[system]' },
  { regex: /\bact\s+as\b/i, label: 'act as' },
  { regex: /\bdisregard\s+your\b/i, label: 'disregard your' },
];

export interface InboundScanFinding {
  /** Human-readable label identifying which pattern matched. */
  pattern: string;
  /**
   * The matched substring from the RAW (pre-sanitization) content, for audit records.
   * Intentionally raw: if an injection phrase was inside a stripped tag, the finding
   * still captures the original text so the audit log has forensic value. Truncated
   * to 100 chars to prevent log bloat on pathological input.
   */
  match: string;
}

export interface InboundScanResult {
  /**
   * Message content after stripping instruction-mimicking tags.
   * This is the value that flows into the agent.task event's content field.
   * If no tags were stripped, this is identical to the original content.
   */
  sanitizedContent: string;
  /**
   * Injection risk score in [0, 1].
   * 0 = no patterns detected; 1 = all configured patterns matched.
   * Computed as matchedPatterns / totalPatterns, capped at 1.0.
   */
  riskScore: number;
  /** The patterns that fired, for audit logging. Empty when riskScore is 0. */
  findings: InboundScanFinding[];
}

export interface InboundScannerConfig {
  /**
   * Additional injection patterns loaded from config (e.g. config/default.yaml).
   * Merged with the built-in defaults at construction time.
   */
  extraPatterns?: Array<{ regex: RegExp; label: string }>;
}

export class InboundScanner {
  private patterns: Array<{ regex: RegExp; label: string }>;

  /** Number of built-in default patterns (independent of any extras). */
  static readonly DEFAULT_PATTERN_COUNT = DEFAULT_INJECTION_PATTERNS.length;

  constructor(config: InboundScannerConfig = {}) {
    this.patterns = [
      ...DEFAULT_INJECTION_PATTERNS,
      ...(config.extraPatterns ?? []),
    ];
  }

  /**
   * Scan an inbound message for prompt injection signals.
   *
   * Steps:
   * 1. Strip instruction-mimicking XML/HTML tags from the content.
   * 2. Check the original content for instruction-like phrases.
   * 3. Compute a risk score proportional to the fraction of patterns that fired.
   *
   * Note: pattern detection runs on the ORIGINAL content (before tag stripping)
   * so that a `<system>ignore previous instructions</system>` payload registers
   * both a tag-strip AND a pattern match — giving the Coordinator maximum signal.
   */
  scan(rawContent: string): InboundScanResult {
    // Step 1: Strip instruction-mimicking tags from content.
    // Paired tags first (e.g. <system>...</system>) to remove injected content;
    // then orphan tags (self-closing or unmatched). This ordering mirrors the
    // approach in sanitize.ts and prevents the paired-content regex from missing
    // matches that the orphan regex would have already consumed.
    let sanitizedContent = rawContent;
    // Reset lastIndex before use — shared global regexes retain state across calls.
    INSTRUCTION_TAG_PAIR_PATTERN.lastIndex = 0;
    sanitizedContent = sanitizedContent.replace(INSTRUCTION_TAG_PAIR_PATTERN, '');
    INSTRUCTION_TAG_ORPHAN_PATTERN.lastIndex = 0;
    sanitizedContent = sanitizedContent.replace(INSTRUCTION_TAG_ORPHAN_PATTERN, '');

    // Step 2: Detect instruction-like phrases in the original content.
    // We test the raw content so that stripped tags still contribute to the risk
    // score — a message that contained <system>...</system> is riskier even after
    // its markup is removed.
    const findings: InboundScanFinding[] = [];
    for (const { regex, label } of this.patterns) {
      // Reset lastIndex before each test — shared global regexes retain state across calls.
      regex.lastIndex = 0;
      // Use string.match() rather than RegExp.exec() — idiomatic for non-global patterns
      // where we only need the first occurrence.
      const matched = rawContent.match(regex);
      if (matched) {
        findings.push({
          pattern: label,
          // Truncate match to 100 chars so audit records don't bloat on pathological input.
          match: matched[0].slice(0, 100),
        });
      }
    }

    // Step 3: Compute risk score.
    // matchedPatterns / totalPatterns, capped at 1.0.
    // Using the combined count (defaults + extras) as the denominator so scores are
    // consistent: a message that matches 3 of 10 configured patterns scores 0.3
    // regardless of whether those 10 are all defaults or a mix with custom entries.
    const riskScore =
      this.patterns.length > 0
        ? Math.min(findings.length / this.patterns.length, 1.0)
        : 0;

    return { sanitizedContent, riskScore, findings };
  }
}
