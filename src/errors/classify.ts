// classify.ts — error classification for agent error recovery.
//
// classifyError() maps raw errors (from LLM providers, Node.js, etc.) into
// structured AgentError values. The runtime uses these for retry decisions,
// budget tracking, and structured error injection into LLM history.
//
// Classification uses status codes, system error codes, and stable Error.name
// discriminants for AbortSignal DOMExceptions — never message-string matching.
// This prevents the fragile pattern matching Zora suffered from.

import type { AgentError, ErrorType } from './types.js';
import { isRetryable } from './types.js';
import { sanitizeOutput } from '../skills/sanitize.js';
import { scrubPii, type PiiPattern } from '../pii/scrubber.js';

// Extra PII patterns loaded from config/default.yaml at startup.
// Injected via setErrorPiiPatterns() in index.ts after config is parsed.
// Using module-level state avoids threading extra parameters through every
// classifyError / classifySkillError call in the codebase.
let _extraPiiPatterns: PiiPattern[] = [];

/**
 * Configure additional PII patterns for LLM-facing error messages.
 * Call once at startup after loading pii.extra_patterns from default.yaml.
 */
export function setErrorPiiPatterns(patterns: PiiPattern[]): void {
  _extraPiiPatterns = patterns;
}

// HTTP status code → ErrorType mapping.
// Checked first (most reliable signal).
const STATUS_MAP: Record<number, ErrorType> = {
  400: 'VALIDATION_ERROR',
  401: 'AUTH_FAILURE',
  403: 'AUTH_FAILURE',
  404: 'NOT_FOUND',
  408: 'TIMEOUT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMIT',
  500: 'PROVIDER_ERROR',
  502: 'PROVIDER_ERROR',
  503: 'PROVIDER_ERROR',
  529: 'PROVIDER_ERROR',  // Anthropic: overloaded
};

// Node.js system error code → ErrorType mapping.
// Checked second (when no HTTP status is available).
const CODE_MAP: Record<string, ErrorType> = {
  ETIMEDOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
  ECONNREFUSED: 'PROVIDER_ERROR',
  ECONNRESET: 'PROVIDER_ERROR',
  ENOTFOUND: 'PROVIDER_ERROR',
  ENOENT: 'NOT_FOUND',
  EACCES: 'AUTH_FAILURE',
  EPERM: 'AUTH_FAILURE',
};

// AbortSignal DOMException.name → ErrorType. These errors expose a numeric
// `.code` (e.g. 23) that CODE_MAP cannot see — name is the stable discriminant.
// TimeoutError: AbortSignal.timeout(). AbortError: caller abort / AbortSignal.any.
const ABORT_NAME_MAP: Record<string, ErrorType> = {
  TimeoutError: 'TIMEOUT',
  AbortError: 'TIMEOUT',
};

// Max length for sanitized error messages injected into LLM context.
// sanitizeOutput() appends '[truncated — output exceeded limit]' (35 chars) when it truncates,
// so the actual output can be up to maxLength + 35 chars. We use 400
// as the nominal limit — the slight overshoot is acceptable for error context.
const MAX_MESSAGE_LENGTH = 400;

/**
 * Extract a human-readable message from an unknown error value.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return 'Unknown error (no details available)';
  return String(err);
}

/**
 * Sanitize an error message for safe inclusion in LLM context.
 *
 * Two-pass pipeline:
 * 1. scrubPii() — remove email addresses, phone numbers, credit card numbers,
 *    and other PII before the message reaches the LLM's context window.
 *    The audit log retains the original unredacted error separately.
 * 2. sanitizeOutput() — strip XML injection tags, redact API key patterns,
 *    and truncate to the 400-char limit.
 */
function sanitizeMessage(message: string): string {
  const piiScrubbed = scrubPii(message, _extraPiiPatterns);
  return sanitizeOutput(piiScrubbed, { maxLength: MAX_MESSAGE_LENGTH });
}

/**
 * Classify a raw error into a structured AgentError.
 *
 * Classification priority:
 * 1. HTTP status code (most reliable — from API responses)
 * 2. Node.js error code (system-level failures)
 * 3. AbortSignal DOMException name (TimeoutError / AbortError)
 * 4. Fallback to UNKNOWN
 *
 * Note: Postgres outages are classified at DB call sites via
 * `createDbUnavailableAgentError` / `isDbUnavailableError` (#1381). Generic
 * ECONNREFUSED here remains PROVIDER_ERROR so LLM/network failures are not
 * mislabeled as DATABASE_UNAVAILABLE.
 */
export function classifyError(err: unknown, source: string): AgentError {
  const rawMessage = extractMessage(err);
  const context: Record<string, unknown> = {};

  let type: ErrorType = 'UNKNOWN';

  // 1. Check HTTP status (works for Anthropic SDK errors and fetch-style errors)
  const status = (err as Record<string, unknown>)?.status;
  if (typeof status === 'number' && STATUS_MAP[status]) {
    type = STATUS_MAP[status];
    context.status = status;
  }

  // 2. Check Node.js error code (ETIMEDOUT, ECONNREFUSED, etc.)
  // Always capture code in context for debugging, even if status already classified.
  const code = (err as Record<string, unknown>)?.code;
  if (typeof code === 'string') {
    context.code = code;
    if (type === 'UNKNOWN' && CODE_MAP[code]) {
      type = CODE_MAP[code];
    }
  }

  // 3. AbortSignal timeout / abort DOMExceptions. `.code` is numeric here, so
  // step 2 cannot see them — use the stable Error.name discriminant (#1597).
  // Object.hasOwn: a bare map lookup walks Object.prototype, so a weird
  // err.name like `toString` must not resolve to an inherited function.
  if (
    type === 'UNKNOWN'
    && err instanceof Error
    && Object.hasOwn(ABORT_NAME_MAP, err.name)
  ) {
    type = ABORT_NAME_MAP[err.name]!;
    context.abortName = err.name;
  }

  // 4. Prefer an AgentError already attached by a DB call site (#1381).
  const attached = (err as { agentError?: AgentError })?.agentError;
  if (attached && attached.type === 'DATABASE_UNAVAILABLE') {
    return attached;
  }

  return {
    type,
    source,
    message: sanitizeMessage(rawMessage),
    retryable: isRetryable(type),
    context,
    timestamp: new Date(),
  };
}

/**
 * Classify a skill failure into an AgentError.
 * Skills return { success: false, error: string } — always SKILL_ERROR.
 */
export function classifySkillError(toolName: string, error: string): AgentError {
  return {
    type: 'SKILL_ERROR',
    source: `skill:${toolName}`,
    message: sanitizeMessage(error),
    retryable: isRetryable('SKILL_ERROR'),
    context: { toolName },
    timestamp: new Date(),
  };
}

/**
 * Escape XML special characters to prevent injection into <task_error> blocks.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Reporting constraint carried by every <task_error> (#1546).
 *
 * The prod incident behind #1546 was not a missing-information failure: the
 * `<task_error>` block was already in context, with `is_error: true`, when the
 * coordinator told the CEO "Got it — I've noted the dismissal." The model had
 * the evidence and did not weight it. So this states the reporting rule at the
 * point of maximum salience — the last line the model reads before resuming
 * generation — rather than relying on a rule several hundred lines up in the
 * system prompt.
 *
 * Deliberately scoped in two directions: a later successful attempt at the same
 * action IS reportable as success, and other actions in the same turn are
 * unaffected. Without those carve-outs the constraint would suppress honest
 * reporting of the work that did land.
 */
const TASK_ERROR_REPORTING_CONSTRAINT =
  'This call did not succeed. Do not state or imply to the user that this action '
  + 'was completed unless a later attempt at it succeeds. Work that did succeed in '
  + 'this turn may be reported normally.';

/**
 * Format a structured <task_error> XML block for injection into LLM history.
 * Terminal leaf — no nested XML, no child tags inside <message>.
 *
 * <reporting_constraint> is last so it sits closest to the resumption point.
 */
export function formatTaskError(
  toolName: string,
  errorType: string,
  message: string,
  attempt: number,
  maxAttempts: number,
): string {
  return [
    '<task_error>',
    `  <tool>${escapeXml(toolName)}</tool>`,
    `  <error_type>${escapeXml(errorType)}</error_type>`,
    `  <message>${escapeXml(message)}</message>`,
    `  <attempt>${attempt} of ${maxAttempts}</attempt>`,
    `  <reporting_constraint>${TASK_ERROR_REPORTING_CONSTRAINT}</reporting_constraint>`,
    '</task_error>',
  ].join('\n');
}
