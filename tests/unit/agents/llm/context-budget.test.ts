import { describe, it, expect } from 'vitest';
import { ContextBudget } from '../../../../src/agents/llm/context-budget.js';
import type { Message } from '../../../../src/agents/llm/provider.js';

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

  describe('allocateRequired', () => {
    it('always includes the tier and deducts tokens', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0,
      });
      // available = 900
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(350) }];
      // 350 chars / 3.5 = 100 tokens + 4 overhead = 104
      budget.allocateRequired('system_prompt', messages);
      expect(budget.remaining).toBe(900 - 104);
    });

    it('allows remaining to go negative on overflow without throwing', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100,
        responseReserve: 10,
        safetyMargin: 0.0,
      });
      // available = 90
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(700) }];
      // 700 / 3.5 = 200 + 4 = 204
      budget.allocateRequired('system_prompt', messages);
      expect(budget.remaining).toBe(90 - 204);
    });
  });

  describe('allocate', () => {
    it('includes a tier that fits and deducts tokens', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0,
      });
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(350) }];
      const included = budget.allocate('sender_context', messages);
      expect(included).toBe(true);
      expect(budget.remaining).toBe(900 - 104);
    });

    it('drops a tier that does not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 150
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(700) }];
      // 700 / 3.5 = 200 + 4 = 204 > 150
      const included = budget.allocate('bullpen', messages);
      expect(included).toBe(false);
      expect(budget.remaining).toBe(150);
    });

    it('drops a tier with empty messages', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0,
      });
      const included = budget.allocate('bullpen', []);
      expect(included).toBe(false);
      expect(budget.remaining).toBe(900);
    });

    it('independently evaluates tiers — a dropped tier does not block subsequent tiers', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 500,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 450
      const large: Message[] = [{ role: 'system', content: 'x'.repeat(3500) }];
      // 3500/3.5 = 1000 + 4 = 1004 > 450
      expect(budget.allocate('sender_context', large)).toBe(false);

      const small: Message[] = [{ role: 'system', content: 'x'.repeat(35) }];
      // 35/3.5 = 10 + 4 = 14 < 450
      expect(budget.allocate('bullpen', small)).toBe(true);
      expect(budget.remaining).toBe(450 - 14);
    });
  });

  describe('allocateHistory', () => {
    function turn(chars: number): Message {
      return { role: 'user', content: 'x'.repeat(chars) };
    }

    it('includes full history when it fits', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });
      const turns = [turn(35), turn(35), turn(35)];
      const included = budget.allocateHistory(turns);
      expect(included).toHaveLength(3);
      expect(budget.remaining).toBe(9_000 - 42);
    });

    it('truncates oldest turns when full history does not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      const turns = [turn(350), turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns);
      expect(included).toHaveLength(1);
      expect(included[0]).toBe(turns[3]);
    });

    it('respects minKeep — keeps at least minKeep recent turns', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 500,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      const turns = [turn(35), turn(35), turn(35), turn(35), turn(35)];
      const included = budget.allocateHistory(turns, 3);
      expect(included).toHaveLength(5);
    });

    it('drops all history when even minKeep turns do not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      const turns = [turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns, 2);
      expect(included).toHaveLength(0);
      expect(budget.remaining).toBe(50);
    });

    it('returns empty array for empty turns', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });
      const included = budget.allocateHistory([]);
      expect(included).toHaveLength(0);
    });

    it('defaults minKeep to 2', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 300,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      const turns = [turn(350), turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns);
      expect(included).toHaveLength(2);
      expect(included[0]).toBe(turns[2]);
      expect(included[1]).toBe(turns[3]);
    });
  });

  describe('getReport', () => {
    it('returns correct report after mixed allocation', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });

      budget.allocateRequired('system_prompt', [{ role: 'system', content: 'x'.repeat(350) }]);
      budget.allocate('sender_context', [{ role: 'system', content: 'x'.repeat(35) }]);
      budget.allocateHistory([
        { role: 'user', content: 'x'.repeat(35) },
        { role: 'assistant', content: 'x'.repeat(35) },
        { role: 'user', content: 'x'.repeat(35) },
      ]);
      budget.allocate('bullpen', []);

      const report = budget.getReport();
      expect(report.model).toBe('claude-sonnet-4-6');
      expect(report.contextWindow).toBe(10_000);
      expect(report.responseReserve).toBe(1_000);
      expect(report.availableBudget).toBe(9_000);
      expect(report.totalUsed).toBe(160);
      expect(report.utilizationPct).toBeCloseTo(160 / 9_000, 5);
      expect(report.tiers).toHaveLength(4);
      expect(report.tiers[0]).toEqual({ name: 'system_prompt', estimatedTokens: 104, included: true });
      expect(report.tiers[1]).toEqual({ name: 'sender_context', estimatedTokens: 14, included: true });
      expect(report.tiers[2]).toEqual({ name: 'conversation_history', estimatedTokens: 42, included: true });
      expect(report.tiers[3]).toEqual({ name: 'bullpen', estimatedTokens: 0, included: false, droppedReason: 'empty' });
      expect(report.historyTurnsTotal).toBe(3);
      expect(report.historyTurnsIncluded).toBe(3);
    });

    it('reports correct utilization when tiers are dropped', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      budget.allocateRequired('system_prompt', [{ role: 'system', content: 'x'.repeat(350) }]);
      budget.allocate('sender_context', [{ role: 'system', content: 'x'.repeat(700) }]);

      const report = budget.getReport();
      expect(report.totalUsed).toBe(104);
      expect(report.tiers[1]).toEqual({
        name: 'sender_context',
        estimatedTokens: 204,
        included: false,
        droppedReason: 'budget_exceeded',
      });
    });
  });
});
