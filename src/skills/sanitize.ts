// sanitize.ts — output sanitization for skill results.
//
// Every skill result passes through this before being fed back to an LLM.
// This is a security boundary: skill outputs can contain injection vectors
// (HTML/XML tags that look like system instructions, leaked API keys, etc.)
// and we must strip them before they reach the LLM's context window.
//
// Lesson from Zora: tool outputs without sanitization are a prompt injection vector.

export interface SanitizeOptions {
  /** Max output length in characters. Default: 10000. */
  maxLength?: number;
  /** If true, wraps the output in <tool_error> tags. */
  isError?: boolean;
  /** Additional regex patterns to redact (beyond built-in API key patterns). */
  extraRedactPatterns?: RegExp[];
}

// Patterns matching common secret formats — these are redacted from all skill output.
// Order matters: more specific patterns first to avoid partial matches.
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // Bearer tokens (JWT or opaque)
  /Bearer\s+[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+/=]*/g,
  // Generic long hex tokens (32+ chars)
  /(?<![a-zA-Z0-9])[a-f0-9]{32,}(?![a-zA-Z0-9])/g,
];

// Tags that could be interpreted as system-level instructions by an LLM.
// We strip these entirely (tag + content for paired tags, just the tag for self-closing).
const DANGEROUS_TAG_PATTERN = /<\/?(system|instruction|prompt|role|script|iframe|object|embed|applet)[^>]*>/gi;

/**
 * Sanitize skill output before feeding it back to an LLM.
 *
 * Steps (in order):
 * 1. Coerce non-strings to JSON
 * 2. Strip dangerous HTML/XML tag pairs + content, then orphan tags
 * 3. Redact secret patterns
 * 4. Truncate to length limit
 * 5. Wrap errors in <tool_error> tags
 */
export function sanitizeOutput(
  raw: string | unknown,
  options: SanitizeOptions = {},
): string {
  const { maxLength = 10000, isError = false, extraRedactPatterns = [] } = options;

  // 1. Coerce non-strings to JSON so we always work with a string
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      text = JSON.stringify(raw, null, 2);
    } catch {
      // Deliberate fallback: if JSON.stringify fails (circular refs, etc.),
      // String() coercion is safe enough for sanitization purposes
      text = String(raw);
    }
  }

  // 2. Strip dangerous tag pairs WITH their content first (e.g., <system>...</system>)
  // This must happen before stripping orphan tags — if we strip tags first,
  // the paired-content regex has nothing to match and the injected content survives.
  text = text.replace(/<(system|instruction|prompt|role|script)[\s>][\s\S]*?<\/\1>/gi, '');
  // Then strip any remaining orphan dangerous tags (self-closing or unmatched)
  text = text.replace(DANGEROUS_TAG_PATTERN, '');

  // 3. Redact known secret patterns
  const allPatterns = [...SECRET_PATTERNS, ...extraRedactPatterns];
  for (const pattern of allPatterns) {
    // Reset lastIndex for global patterns since we reuse them across calls
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED]');
  }

  // 4. Truncate if exceeding length limit
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + '[truncated]';
  }

  // 5. Wrap errors in <tool_error> tags so the LLM can distinguish
  // error output from normal output and handle it appropriately
  if (isError) {
    text = `<tool_error>${text}</tool_error>`;
  }

  return text;
}
