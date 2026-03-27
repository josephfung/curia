// types.ts — structured error types for agent error recovery.
//
// AgentError is cross-cutting: used by providers, runtime, bus, and skills.
// ErrorType is a discriminated union — never match error strings.

export type ErrorType =
  | 'AUTH_FAILURE'       // 401/403 — never retry, counts double against budget
  | 'RATE_LIMIT'         // 429 — retryable with backoff
  | 'TIMEOUT'            // request timeout, ETIMEDOUT
  | 'NOT_FOUND'          // 404, ENOENT
  | 'VALIDATION_ERROR'   // malformed input, schema violation
  | 'PROVIDER_ERROR'     // 5xx, upstream LLM failure
  | 'SKILL_ERROR'        // skill returned { success: false }
  | 'BUDGET_EXCEEDED'    // turn or error budget exhausted
  | 'UNKNOWN';           // fallback — something unexpected

export interface AgentError {
  type: ErrorType;
  source: string;           // e.g. 'anthropic', 'skill:email-send', 'runtime'
  message: string;          // human-readable, sanitized (max 400 chars, no injection vectors)
  retryable: boolean;       // deterministic from ErrorType via isRetryable()
  context: Record<string, unknown>;  // structured metadata (status code, tool name, etc.)
  timestamp: Date;
}

export interface ErrorBudget {
  maxTurns: number;              // max LLM round-trips per task (default: 20)
  maxConsecutiveErrors: number;  // max consecutive errors before abort (default: 5)
  turnsUsed: number;
  consecutiveErrors: number;
}

// Retryable is deterministic from ErrorType — no per-instance overrides.
// AUTH_FAILURE and BUDGET_EXCEEDED are never retryable.
// RATE_LIMIT, TIMEOUT, and PROVIDER_ERROR are retryable (transient failures).
const RETRYABLE_TYPES: ReadonlySet<ErrorType> = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'PROVIDER_ERROR',
]);

export function isRetryable(type: ErrorType): boolean {
  return RETRYABLE_TYPES.has(type);
}

export const DEFAULT_ERROR_BUDGET = {
  maxTurns: 20,
  maxConsecutiveErrors: 5,
} as const;
