// src/memory/sensitivity.test.ts
import { describe, it, expect } from 'vitest';
import { SensitivityClassifier, parseSensitivityRules } from './sensitivity.js';

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

describe('parseSensitivityRules', () => {
  it('normalizes patterns to lowercase and trims whitespace', () => {
    const rules = parseSensitivityRules(
      [{ category: 'financial', sensitivity: 'confidential', patterns: ['  Revenue  ', 'BUDGET'] }],
      'test',
    );
    expect(rules).toEqual([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue', 'budget'] },
    ]);
  });

  it('throws when the input is not an array', () => {
    expect(() => parseSensitivityRules({ not: 'an array' }, 'test')).toThrow('must be an array');
  });

  it('throws when an entry is missing category', () => {
    expect(() =>
      parseSensitivityRules([{ sensitivity: 'confidential', patterns: ['x'] }], 'test'),
    ).toThrow("missing 'category'");
  });

  it('throws a validation Error (not a raw TypeError) when a list entry is null', () => {
    // A bare `-` in YAML (e.g. a stray list item) parses to null.
    expect(() =>
      parseSensitivityRules([null, { category: 'x', sensitivity: 'confidential', patterns: ['x'] }], 'test'),
    ).toThrow("sensitivity_rules[0] must be an object with 'category', 'sensitivity', and 'patterns' fields");
  });

  it('throws a validation Error when a list entry is a primitive', () => {
    expect(() => parseSensitivityRules(['not an object'], 'test')).toThrow(
      "sensitivity_rules[0] must be an object with 'category', 'sensitivity', and 'patterns' fields",
    );
  });

  it('throws when sensitivity is not a known level', () => {
    expect(() =>
      parseSensitivityRules([{ category: 'x', sensitivity: 'ultra', patterns: ['x'] }], 'test'),
    ).toThrow("unknown sensitivity 'ultra'");
  });

  it('throws when patterns is empty', () => {
    expect(() =>
      parseSensitivityRules([{ category: 'x', sensitivity: 'confidential', patterns: [] }], 'test'),
    ).toThrow("'patterns' must be a non-empty array");
  });

  it('throws when a pattern is blank after trimming', () => {
    expect(() =>
      parseSensitivityRules([{ category: 'x', sensitivity: 'confidential', patterns: ['  '] }], 'test'),
    ).toThrow('patterns must not contain empty values');
  });

  it('the resulting rules feed directly into SensitivityClassifier.fromRules', () => {
    const rules = parseSensitivityRules(
      [{ category: 'financial', sensitivity: 'confidential', patterns: ['Revenue'] }],
      'test',
    );
    const classifier = SensitivityClassifier.fromRules(rules);
    expect(classifier.classify('Q3 revenue report', {})).toBe('confidential');
  });
});
