// llm-outcome-tracker.ts — in-memory recorder of per-key LLM/embedding call outcomes.
//
// Maintained by HealthService via bus event subscriptions (llm.call, llm.error,
// embedding.call, embedding.error, tool.result). Read by runCanaries() to determine
// whether each capability tier has been healthy without making billed probe calls.

import type { TrackerKey, TierOutcome } from './types.js';

export class LlmOutcomeTracker {
  private readonly outcomes = new Map<TrackerKey, TierOutcome>();

  recordSuccess(key: TrackerKey): void {
    const existing = this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null, lastOutcome: null };
    this.outcomes.set(key, { ...existing, lastSuccessAt: new Date(), lastOutcome: 'success' });
  }

  recordError(key: TrackerKey): void {
    const existing = this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null, lastOutcome: null };
    this.outcomes.set(key, { ...existing, lastErrorAt: new Date(), lastOutcome: 'error' });
  }

  getOutcome(key: TrackerKey): TierOutcome {
    return this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null, lastOutcome: null };
  }
}
