// src/memory/sensitivity.test.ts
import { describe, it, expect } from 'vitest';
import { SensitivityClassifier } from './sensitivity.js';

describe('SensitivityClassifier', () => {
  it('classifies financial content as confidential based on keyword rule', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
    ]);
    expect(classifier.classify('Q3 revenue forecast', {})).toBe('confidential');
  });

  it('defaults to internal when no rule matches', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
    ]);
    expect(classifier.classify('team standup notes', {})).toBe('internal');
  });

  it('matches keywords in property values, not just the label', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['salary'] },
    ]);
    expect(classifier.classify('employee record', { details: 'salary adjustment' })).toBe('confidential');
  });

  it('category hint bypasses keyword scanning', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'hr', sensitivity: 'confidential', patterns: ['performance'] },
    ]);
    // Label doesn't contain 'performance' but the category hint matches
    expect(classifier.classify('annual review', {}, 'hr')).toBe('confidential');
  });

  it('most restrictive rule wins when multiple patterns match', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
      { category: 'board', sensitivity: 'restricted', patterns: ['board'] },
    ]);
    // Both match — restricted wins
    expect(classifier.classify('board revenue discussion', {})).toBe('restricted');
  });
});
