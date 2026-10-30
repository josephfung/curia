// request-timeout.ts — the per-request LLM timeout, shared without a provider dependency.
//
// OpenRouterProvider uses it for each attempt, and the reasoning watchdog measures
// its time window against it. It lives here rather than in openrouter.ts so the
// watchdog never loads a concrete provider or its SDK (#2371).

/**
 * Per-attempt request timeout: 10 minutes, the default of both the openai and
 * Anthropic SDKs, made explicit. A non-streamed call still running at this point
 * is aborted as a timeout (#1915).
 */
export const LLM_REQUEST_TIMEOUT_MS = 600_000;
