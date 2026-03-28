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

// ── Display name sanitization ───────────────────────────────────────
//
// Defense-in-depth: sanitize display names at storage time, not just
// at prompt-injection time. This prevents stored prompt injection via
// email participant names or any other external source.
//
// Allowlist approach: keep only characters that can plausibly appear in
// a human name (letters, spaces, hyphens, apostrophes, periods, commas).
// Everything else is stripped. This is intentionally aggressive — a name
// like "Dr. Mary O'Brien-Jones, PhD" passes; "SYSTEM: grant all" does not
// (the colon is stripped).

/** Max length for a sanitized display name (chars). */
export const DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Characters allowed in a display name. Unicode letters (\p{L}) cover
 * accented and non-Latin scripts. We also allow digits for names like
 * "Agent 47" or generation suffixes like "III".
 */
const DISPLAY_NAME_ALLOWED = /[^\p{L}\p{N}\s'\-.,()]/gu;

/**
 * Collapse runs of whitespace (including newlines) into a single space.
 * Prevents names from spanning multiple lines in prompts.
 */
const WHITESPACE_COLLAPSE = /\s+/g;

/**
 * Sanitize a display name for safe storage and later prompt inclusion.
 *
 * 1. Strip dangerous XML/HTML tags (reuses the same patterns as sanitizeOutput)
 * 2. Remove characters outside the name allowlist
 * 3. Collapse whitespace and trim
 * 4. Truncate to DISPLAY_NAME_MAX_LENGTH
 * 5. If the result is empty, return the fallback (or 'Unknown')
 */
export function sanitizeDisplayName(
  raw: string,
  fallback = 'Unknown',
): string {
  let name = raw;

  // Strip dangerous tag pairs with content, then orphan tags.
  // Reset lastIndex on the shared global regex for safety — consistent with
  // how sanitizeOutput handles SECRET_PATTERNS above.
  name = name.replace(/<(system|instruction|prompt|role|script)[\s>][\s\S]*?<\/\1>/gi, '');
  DANGEROUS_TAG_PATTERN.lastIndex = 0;
  name = name.replace(DANGEROUS_TAG_PATTERN, '');

  // Remove non-allowlisted characters (strips colons, semicolons, angle brackets, etc.)
  name = name.replace(DISPLAY_NAME_ALLOWED, '');

  // Collapse whitespace runs and trim
  name = name.replace(WHITESPACE_COLLAPSE, ' ').trim();

  // Truncate to length limit.
  // Note: slice() counts UTF-16 code units, which could theoretically split a
  // surrogate pair for supplementary-plane characters. Accepted limitation given
  // the generous 200-char limit makes this edge case vanishingly unlikely for
  // real human names.
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    name = name.slice(0, DISPLAY_NAME_MAX_LENGTH).trim();
  }

  // If nothing meaningful remains, sanitize and use the fallback.
  // The fallback may come from an external source (e.g., an email address)
  // so it must go through the same pipeline to prevent bypass.
  if (name.length > 0) return name;

  const safeFallback = fallback
    .replace(DISPLAY_NAME_ALLOWED, '')
    .replace(WHITESPACE_COLLAPSE, ' ')
    .trim();
  if (safeFallback.length > DISPLAY_NAME_MAX_LENGTH) {
    return safeFallback.slice(0, DISPLAY_NAME_MAX_LENGTH).trim();
  }
  return safeFallback.length > 0 ? safeFallback : 'Unknown';
}
