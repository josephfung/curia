// task-error-budget.ts — validation for per-task error_budget JSONB (#883).
//
// Per-invocation turn limits (maxTurns / maxConsecutiveErrors) are configured in
// agent YAML only. The per-task column holds resumable-task metadata and aggregate
// ceiling overrides (#1176).

/** Keys that configure resumable tasks and aggregate ceilings — the only supported per-task fields. */
export const ALLOWED_TASK_ERROR_BUDGET_KEYS = new Set([
  'resumable',
  'max_stalls',
  'max_iterations',
  'max_wallclock_hours',
  'max_cost_usd',
]);

/** Per-invocation budget keys — rejected on tasks; belong in agent YAML (error_budget.max_turns / max_errors). */
export const FORBIDDEN_PER_INVOCATION_BUDGET_KEYS = new Set([
  'maxTurns',
  'maxConsecutiveErrors',
  'max_turns',
  'max_errors',
]);

const NUMERIC_CEILING_KEYS = [
  'max_stalls',
  'max_iterations',
  'max_wallclock_hours',
  'max_cost_usd',
] as const;

/**
 * Validate a task error_budget object before persistence.
 * Returns an error message when invalid, or null when acceptable.
 */
export function validateTaskErrorBudget(errorBudget: Record<string, unknown>): string | null {
  for (const key of Object.keys(errorBudget)) {
    if (FORBIDDEN_PER_INVOCATION_BUDGET_KEYS.has(key)) {
      return (
        `error_budget.${key} is not supported on tasks — per-invocation turn limits are ` +
        `configured in agent YAML (error_budget.max_turns / max_errors), not per-task. ` +
        `Use resumable ceiling keys (max_stalls, max_iterations, max_wallclock_hours, max_cost_usd) ` +
        `or set resumable: true.`
      );
    }
    if (!ALLOWED_TASK_ERROR_BUDGET_KEYS.has(key)) {
      return (
        `error_budget.${key} is not a recognized task error_budget key. ` +
        `Allowed: ${[...ALLOWED_TASK_ERROR_BUDGET_KEYS].join(', ')}.`
      );
    }
  }

  if ('resumable' in errorBudget && typeof errorBudget.resumable !== 'boolean') {
    return 'error_budget.resumable must be a boolean.';
  }

  for (const key of NUMERIC_CEILING_KEYS) {
    if (key in errorBudget) {
      const value = errorBudget[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return `error_budget.${key} must be a positive number.`;
      }
    }
  }

  return null;
}
