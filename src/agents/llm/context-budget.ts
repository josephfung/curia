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
export interface TierRecord {
  name: string;
  estimatedTokens: number;
  included: boolean;
  droppedReason?: 'budget_exceeded' | 'empty';
}

// A snapshot of the context budget state after all tiers have been allocated.
// Emitted on the context.budget bus event (Task 7) and used for observability.
export interface ContextBudgetReport {
  model: string;
  contextWindow: number;
  responseReserve: number;
  availableBudget: number;
  totalUsed: number;
  utilizationPct: number;
  tiers: TierRecord[];
  historyTurnsTotal: number;
  historyTurnsIncluded: number;
}

export class ContextBudget {
  readonly availableBudget: number;
  private _remaining: number;

  private readonly config: ContextBudgetConfig;
  private tiers: TierRecord[] = [];
  private historyTurnsTotal = 0;
  private historyTurnsIncluded = 0;

  constructor(config: ContextBudgetConfig) {
    this.config = config;
    // Reserve a safety margin as a fraction of the total context window,
    // rounded up to avoid floating-point edge cases near the boundary.
    const safetyReserve = Math.ceil(config.contextWindow * config.safetyMargin);
    // Available tokens = total window minus what we reserve for the model's
    // response and the safety margin.
    this.availableBudget = config.contextWindow - config.responseReserve - safetyReserve;
    // Remaining starts equal to available; decremented as tiers are allocated.
    this._remaining = this.availableBudget;
  }

  /** Tokens remaining after all allocations so far. Can go negative after allocateRequired. */
  get remaining(): number {
    return this._remaining;
  }

  // Returns a snapshot of allocation decisions for logging and debugging.
  // Includes per-tier records and history turn counts from allocateHistory.
  get diagnostics(): {
    model: string;
    availableBudget: number;
    remaining: number;
    tiers: ReadonlyArray<Readonly<TierRecord>>;
    historyTurnsTotal: number;
    historyTurnsIncluded: number;
  } {
    return {
      model: this.config.model,
      availableBudget: this.availableBudget,
      remaining: this._remaining,
      tiers: this.tiers,
      historyTurnsTotal: this.historyTurnsTotal,
      historyTurnsIncluded: this.historyTurnsIncluded,
    };
  }

  // Always include this tier (e.g. system prompt) regardless of remaining budget.
  // Remaining can go negative — the caller is responsible for deciding whether
  // that is acceptable (system prompt overflow is still better than no prompt).
  allocateRequired(tierName: string, messages: Message[]): void {
    const tokens = estimateMessagesTokens(messages);
    this._remaining -= tokens;
    this.tiers.push({ name: tierName, estimatedTokens: tokens, included: true });
  }

  // Include as many of the most-recent history turns as fit within the
  // remaining budget. Turns are in chronological order (oldest first); we
  // always keep the most recent turns when truncating.
  //
  // minKeep: soft preference for how many recent turns to guarantee. If the
  // budget allows any turns at all, we greedily include as many as fit (up to
  // the full history). The only hard drop-all case is when no single turn fits
  // within the remaining budget — in that case we return an empty array.
  //
  // NOTE: minKeep is accepted as a parameter for API symmetry and future use
  // (e.g. a caller could enforce a hard floor), but the current selection
  // logic is purely greedy: include as many recent turns as fit.
  allocateHistory(turns: Message[], minKeep = 2): Message[] {
    // minKeep is intentionally unused in the selection logic for now — the
    // greedy approach already ensures we include the most turns possible.
    // It is preserved in the signature for forward compatibility.
    void minKeep;

    this.historyTurnsTotal = turns.length;

    if (turns.length === 0) {
      this.historyTurnsIncluded = 0;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: 0, included: false, droppedReason: 'empty' });
      return [];
    }

    // Fast path: full history fits — no truncation needed.
    const fullTokens = estimateMessagesTokens(turns);
    if (fullTokens <= this._remaining) {
      this._remaining -= fullTokens;
      this.historyTurnsIncluded = turns.length;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: fullTokens, included: true });
      return turns;
    }

    // Binary search for the maximum number of recent turns that fit within the
    // remaining budget. Searches [1, turns.length]; lo tracks the best known
    // count that fits (0 means nothing fits yet).
    let lo = 0;
    let searchLo = 1;
    let searchHi = turns.length;
    while (searchLo <= searchHi) {
      const mid = Math.floor((searchLo + searchHi) / 2);
      const slice = turns.slice(-mid);
      if (estimateMessagesTokens(slice) <= this._remaining) {
        lo = mid;
        searchLo = mid + 1;
      } else {
        searchHi = mid - 1;
      }
    }

    // If no single turn fits, drop all history rather than returning a partial
    // result that could confuse the model.
    if (lo === 0) {
      this.historyTurnsIncluded = 0;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: fullTokens, included: false, droppedReason: 'budget_exceeded' });
      return [];
    }

    const included = turns.slice(-lo);
    const tokens = estimateMessagesTokens(included);
    this._remaining -= tokens;
    this.historyTurnsIncluded = included.length;
    this.tiers.push({ name: 'conversation_history', estimatedTokens: tokens, included: true });
    return included;
  }

  // Returns a point-in-time report of all allocation decisions made so far.
  // Safe to call at any point during allocation; typically called after all
  // tiers have been evaluated. The tiers array is a shallow copy.
  getReport(): ContextBudgetReport {
    const totalUsed = this.tiers
      .filter(t => t.included)
      .reduce((sum, t) => sum + t.estimatedTokens, 0);

    return {
      model: this.config.model,
      contextWindow: this.config.contextWindow,
      responseReserve: this.config.responseReserve,
      availableBudget: this.availableBudget,
      totalUsed,
      utilizationPct: this.availableBudget > 0 ? totalUsed / this.availableBudget : 0,
      tiers: [...this.tiers],
      historyTurnsTotal: this.historyTurnsTotal,
      historyTurnsIncluded: this.historyTurnsIncluded,
    };
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

    if (tokens <= this._remaining) {
      this._remaining -= tokens;
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
