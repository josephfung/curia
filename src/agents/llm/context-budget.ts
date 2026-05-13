// Token-aware context budget for agent LLM calls.
//
// Wraps the existing priority-ordered assembly in runtime.ts with
// measurement and enforcement. Each tier is independently checked
// against remaining budget — if it fits, include and deduct; if not,
// drop it and move on. System prompt is always included.
//
// See: docs/wip/2026-05-12-context-budget-design.md

import type { Message } from './provider.js';
import { estimateMessagesTokens } from './token-estimator.js';

export interface ContextBudgetConfig {
  model: string;
  contextWindow: number;
  responseReserve: number;
  safetyMargin: number;
}

export class ContextBudget {
  readonly availableBudget: number;
  remaining: number;

  private readonly config: ContextBudgetConfig;

  constructor(config: ContextBudgetConfig) {
    this.config = config;
    // Reserve a safety margin as a fraction of the total context window,
    // rounded up to avoid floating-point edge cases near the boundary.
    const safetyReserve = Math.ceil(config.contextWindow * config.safetyMargin);
    // Available tokens = total window minus what we reserve for the model's
    // response and the safety margin.
    this.availableBudget = config.contextWindow - config.responseReserve - safetyReserve;
    // Remaining starts equal to available; decremented as tiers are allocated
    // (see allocateRequired / allocate / allocateHistory in later tasks).
    this.remaining = this.availableBudget;
  }
}

// Re-export imports used by subclasses / future methods so they are resolved
// at module parse time and tree-shaken correctly.
export { estimateMessagesTokens };
export type { Message };
