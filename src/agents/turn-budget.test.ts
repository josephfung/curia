import { describe, it, expect } from 'vitest';
import { formatTurnBudgetBlock } from './turn-budget.js';

describe('formatTurnBudgetBlock', () => {
  it('contains the section header', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('## Turn budget');
  });

  it('embeds the max turns count', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('20');
  });

  it('embeds the correct count for a custom value', () => {
    const block = formatTurnBudgetBlock(15);
    expect(block).toContain('15');
  });

  it('frames the budget as a planning constraint from turn 1', () => {
    const block = formatTurnBudgetBlock(20);
    // Should instruct the model to plan, not just warn when close to the limit.
    expect(block).toContain('Plan your tool use');
  });

  it('instructs the model to limit exploratory calls', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('exploratory');
  });

  it('instructs the model not to retry searches repeatedly', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('retry');
  });

  it('instructs the model to produce a partial result near the limit', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('partial');
  });

  it('specifies the 3-turn proximity threshold for early summary', () => {
    const block = formatTurnBudgetBlock(20);
    expect(block).toContain('3 turns');
  });
});
