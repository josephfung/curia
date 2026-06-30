import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TASK_ERROR_BUDGET_KEYS,
  FORBIDDEN_PER_INVOCATION_BUDGET_KEYS,
  validateTaskErrorBudget,
} from '../../../src/tasks/task-error-budget.js';

describe('validateTaskErrorBudget', () => {
  it('accepts an empty object', () => {
    expect(validateTaskErrorBudget({})).toBeNull();
  });

  it.each([null, [], 'string', 42])('rejects non-object input %j', (input) => {
    expect(validateTaskErrorBudget(input)).toBe('error_budget must be an object.');
  });

  it('accepts resumable flag and ceiling overrides', () => {
    expect(
      validateTaskErrorBudget({
        resumable: true,
        max_stalls: 5,
        max_iterations: 50,
        max_wallclock_hours: 12,
        max_cost_usd: 8.5,
      }),
    ).toBeNull();
  });

  it.each([...FORBIDDEN_PER_INVOCATION_BUDGET_KEYS])(
    'rejects per-invocation key %s',
    (key) => {
      const message = validateTaskErrorBudget({ [key]: 10 });
      expect(message).toMatch(/not supported on tasks/);
      expect(message).toContain(key);
    },
  );

  it('rejects unknown keys', () => {
    const message = validateTaskErrorBudget({ maxRetries: 3 });
    expect(message).toMatch(/not a recognized task error_budget key/);
    expect(message).toContain('maxRetries');
  });

  it('rejects non-boolean resumable', () => {
    expect(validateTaskErrorBudget({ resumable: 'yes' })).toBe(
      'error_budget.resumable must be a boolean.',
    );
  });

  it('rejects non-positive ceiling values', () => {
    expect(validateTaskErrorBudget({ max_iterations: 0 })).toBe(
      'error_budget.max_iterations must be a positive integer.',
    );
    expect(validateTaskErrorBudget({ max_cost_usd: -1 })).toBe(
      'error_budget.max_cost_usd must be a positive number.',
    );
    expect(validateTaskErrorBudget({ max_plan_depth: 2.5 })).toBe(
      'error_budget.max_plan_depth must be a positive integer.',
    );
    expect(validateTaskErrorBudget({ throughput_divergence_ratio: 5 })).toBe(
      'error_budget.throughput_divergence_ratio must be in (0, 1].',
    );
  });

  it('documents allowed keys for operator-facing errors', () => {
    const allowed = [...ALLOWED_TASK_ERROR_BUDGET_KEYS].sort();
    expect(allowed).toEqual([
      'blocked_step_hours',
      'max_cost_usd',
      'max_iterations',
      'max_plan_depth',
      'max_replans_per_subtree',
      'max_stalls',
      'max_wallclock_hours',
      'resumable',
      'throughput_divergence_ratio',
    ]);
  });
});
