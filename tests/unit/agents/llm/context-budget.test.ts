import { describe, it, expect } from 'vitest';
import { ContextBudget } from '../../../../src/agents/llm/context-budget.js';

describe('ContextBudget', () => {
  describe('construction', () => {
    it('computes availableBudget as contextWindow - responseReserve - safetyReserve', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200_000,
        responseReserve: 8_192,
        safetyMargin: 0.05,
      });
      // safetyReserve = ceil(200_000 * 0.05) = 10_000
      // available = 200_000 - 8_192 - 10_000 = 181_808
      expect(budget.availableBudget).toBe(181_808);
    });

    it('exposes remaining budget equal to available at start', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100_000,
        responseReserve: 4_000,
        safetyMargin: 0.10,
      });
      // safetyReserve = ceil(100_000 * 0.10) = 10_000
      // available = 100_000 - 4_000 - 10_000 = 86_000
      expect(budget.availableBudget).toBe(86_000);
      expect(budget.remaining).toBe(86_000);
    });
  });
});
