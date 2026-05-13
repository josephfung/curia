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

// Tracks a single tier allocation decision for later logging/diagnostics.
interface TierRecord {
  name: string;
  estimatedTokens: number;
  included: boolean;
  droppedReason?: 'budget_exceeded' | 'empty';
}

export class ContextBudget {
  readonly availableBudget: number;
  remaining: number;

  private readonly config: ContextBudgetConfig;
  private tiers: TierRecord[] = [];

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

  // Always include this tier (e.g. system prompt) regardless of remaining budget.
  // Remaining can go negative — the caller is responsible for deciding whether
  // that is acceptable (system prompt overflow is still better than no prompt).
  allocateRequired(tierName: string, messages: Message[]): void {
    const tokens = estimateMessagesTokens(messages);
    this.remaining -= tokens;
    this.tiers.push({ name: tierName, estimatedTokens: tokens, included: true });
  }

  // Include this tier only if it fits within the remaining budget AND the
  // messages array is non-empty. Returns true if included, false if dropped.
  // Tiers are evaluated independently — dropping one never blocks another.
  allocate(tierName: string, messages: Message[]): boolean {
    const tokens = estimateMessagesTokens(messages);

    // Drop empty tiers immediately — nothing to include.
    if (tokens === 0) {
      this.tiers.push({ name: tierName, estimatedTokens: 0, included: false, droppedReason: 'empty' });
      return false;
    }

    if (tokens <= this.remaining) {
      this.remaining -= tokens;
      this.tiers.push({ name: tierName, estimatedTokens: tokens, included: true });
      return true;
    }

    // Tier is too large — record as dropped but leave remaining unchanged so
    // subsequent smaller tiers still get a fair chance.
    this.tiers.push({ name: tierName, estimatedTokens: tokens, included: false, droppedReason: 'budget_exceeded' });
    return false;
  }
}

// Re-export imports used by subclasses / future methods so they are resolved
// at module parse time and tree-shaken correctly.
export { estimateMessagesTokens };
export type { Message };
