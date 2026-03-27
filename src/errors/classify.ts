// classify.ts — error classification for agent error recovery.
//
// classifyError() maps raw errors (from LLM providers, Node.js, etc.) into
// structured AgentError values. The runtime uses these for retry decisions,
// budget tracking, and structured error injection into LLM history.
//
// Classification uses status codes and error codes — never string matching.
// This prevents the fragile pattern matching Zora suffered from.

import type { AgentError, ErrorType } from './types.js';
import { isRetryable } from './types.js';
import { sanitizeOutput } from '../skills/sanitize.js';

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

// Max length for sanitized error messages injected into LLM context.
// Keeps error context concise and prevents context stuffing.
// Note: sanitizeOutput() appends '[truncated]' (11 chars) when it truncates,
// so we set the slice limit to 399 to keep the total at or under 410.
const MAX_MESSAGE_LENGTH = 399;

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
 * Reuses the existing sanitizeOutput() from skills/sanitize.ts for consistency.
 */
function sanitizeMessage(message: string): string {
  return sanitizeOutput(message, { maxLength: MAX_MESSAGE_LENGTH });
}

/**
 * Classify a raw error into a structured AgentError.
 *
 * Classification priority:
 * 1. HTTP status code (most reliable — from API responses)
 * 2. Node.js error code (system-level failures)
 * 3. Fallback to UNKNOWN
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
  if (type === 'UNKNOWN') {
    const code = (err as Record<string, unknown>)?.code;
    if (typeof code === 'string' && CODE_MAP[code]) {
      type = CODE_MAP[code];
      context.code = code;
    }
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
export function classifySkillError(skillName: string, error: string): AgentError {
  return {
    type: 'SKILL_ERROR',
    source: `skill:${skillName}`,
    message: sanitizeMessage(error),
    retryable: isRetryable('SKILL_ERROR'),
    context: { skillName },
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
 * Format a structured <task_error> XML block for injection into LLM history.
 * Terminal leaf — no nested XML, no child tags inside <message>.
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
    '</task_error>',
  ].join('\n');
}
