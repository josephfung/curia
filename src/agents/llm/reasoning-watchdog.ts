// reasoning-watchdog.ts — limits and forced-attempt copy for the reasoning watchdog (#2371).
//
// A model that reasons for most of its call budget without acting wastes the
// whole call. The watchdog stops such a call at a fraction of its budget and
// re-asks once with the tail of the reasoning, so the model acts on what it
// already worked out. This module is pure: no I/O, no clock reads.

import { LLM_REQUEST_TIMEOUT_MS } from './request-timeout.js';

/** Fire when reasoning tokens reach this fraction of the call's max_tokens cap. */
export const REASONING_WATCHDOG_TOKEN_FRACTION = 0.5;

/**
 * Characters of reasoning text per token, used to estimate tokens from text length.
 * Reasoning text measured 2.5-4.3 characters per token; 3 sits at the low end so the
 * estimate errs toward firing. A reasoning_delta can carry several tokens: CoreWeave
 * (DeepSeek V4.1 Flash) sent about 2.6 tokens per delta, so counting deltas alone
 * could never reach half the cap before the cap itself (#2371).
 */
export const REASONING_CHARS_PER_TOKEN_ESTIMATE = 3;

/** Fire when this fraction of the usable time window has elapsed. */
export const REASONING_WATCHDOG_TIME_FRACTION = 0.5;

/** Time kept back after the watchdog fires so the forced attempt can still finish. */
export const FORCED_ATTEMPT_RESERVE_MS = 60_000;

/** How much of the stopped reasoning is quoted back in the forced message. */
export const FORCED_REASONING_TAIL_CHARS = 16_000;

/** Per-request timeout the time window is measured against (the same value OpenRouter uses). */
export const WATCHDOG_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;

export interface WatchdogLimits {
  /** Reasoning-token count at which the watchdog fires. */
  tokenThreshold: number;
  /** Epoch ms at which the watchdog fires on time. */
  fireAtMs: number;
}

export type WatchdogTrigger = 'tokens' | 'time' | 'cap';

export interface ReasoningWatchdogRecord {
  trigger: WatchdogTrigger;
  firedAtReasoningTokens: number;
  firedAfterMs: number;
  forcedOutcome: 'acted' | 'empty' | 'error';
}

export function watchdogLimits(args: {
  maxTokens: number;
  callStartMs: number;
  deadlineAt?: number;
  requestTimeoutMs?: number;
}): WatchdogLimits {
  const { maxTokens, callStartMs, deadlineAt } = args;
  const requestTimeoutMs = args.requestTimeoutMs ?? WATCHDOG_REQUEST_TIMEOUT_MS;

  // Usable window: up to the run deadline or the request timeout, whichever is
  // sooner, minus the reserve for the forced attempt.
  let window = requestTimeoutMs - FORCED_ATTEMPT_RESERVE_MS;
  if (deadlineAt !== undefined) {
    const bounded = Math.min(deadlineAt, callStartMs + requestTimeoutMs) - callStartMs - FORCED_ATTEMPT_RESERVE_MS;
    // A deadline that is past or inside the reserve gives no usable window;
    // keep the request-timeout basis rather than firing at once.
    if (bounded > 0) window = bounded;
  }

  return {
    tokenThreshold: Math.floor(maxTokens * REASONING_WATCHDOG_TOKEN_FRACTION),
    fireAtMs: callStartMs + window * REASONING_WATCHDOG_TIME_FRACTION,
  };
}

/** Reasoning tokens so far: the delta count or the text-length estimate, whichever is higher. */
export function estimateReasoningTokens(deltaCount: number, reasoningChars: number): number {
  return Math.max(deltaCount, Math.ceil(reasoningChars / REASONING_CHARS_PER_TOKEN_ESTIMATE));
}

export function forcedAttemptMessage(reasoningSoFar: string): string {
  const hasReasoning = reasoningSoFar.length > 0;
  const lines = [
    '[Runtime note from Curia, not from the principal]',
    hasReasoning
      ? 'Your previous attempt at this step was stopped after a long stretch of reasoning with no action. The end of that reasoning is below.'
      : 'Your previous attempt at this step was stopped after a long stretch of reasoning with no action.',
  ];
  if (hasReasoning) {
    const truncated = reasoningSoFar.length > FORCED_REASONING_TAIL_CHARS;
    const tail = truncated ? reasoningSoFar.slice(-FORCED_REASONING_TAIL_CHARS) : reasoningSoFar;
    lines.push('<previous_reasoning>', `${truncated ? '…' : ''}${tail}`, '</previous_reasoning>');
  }
  lines.push(
    'You have already thought this through. Do not start over or re-derive it.',
    'Take your next step now: call the tool you need, or write your reply.',
  );
  return lines.join('\n');
}
