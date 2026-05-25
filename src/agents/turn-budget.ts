// turn-budget.ts — helper for injecting the agent turn budget into system prompts.
//
// Called once per task turn (after ErrorBudget is initialized) so the model always
// sees the effective limit — including any per-agent override from the YAML. The
// language frames the budget as a planning constraint, not just a late-stage warning,
// so models consider it from turn 1 rather than treating their budget as unlimited.
// See issue #689.

/**
 * Format the turn-budget block appended to every agent's system prompt each task turn.
 * Uses the resolved maxTurns value (config override or DEFAULT_ERROR_BUDGET.maxTurns)
 * so the number in the prompt always matches the enforced ceiling.
 *
 * Example output:
 *   ## Turn budget
 *   You have a total budget of 20 turns for this task. A "turn" is one round
 *   of tool calls followed by your response. Plan your tool use accordingly:
 *   - Do not issue exploratory or speculative tool calls when you can act on what you know
 *   - If a search returns no results, try one alternative then move on — do not retry repeatedly
 *   - If a tool call returns an error or unexpected result, accept it and move on. Do not
 *     retry the same tool with different parameters — note the failure in your final output
 *   - After completing your tool calls, produce your final structured response immediately.
 *     Do not make additional tool calls unless genuinely necessary for the task
 *   - When you have fewer than 6 turns remaining, your next response MUST include your
 *     final output, even if the task is incomplete. A partial result with noted gaps is
 *     always better than silence
 *
 * The proximity threshold (the "fewer than N turns remaining" number) scales with
 * maxTurns so low-budget agents aren't told to finalize from turn 1. Formula:
 * max(2, floor(maxTurns / 3)) — roughly the last third of the budget.
 */
export function formatTurnBudgetBlock(maxTurns: number): string {
  // Scale the proximity threshold so low-budget agents still get usable tool turns.
  // floor(maxTurns / 3) gives ~33% of budget; clamped to min 2 so the guidance
  // is always present, even for very small budgets.
  const proximityThreshold = Math.max(2, Math.floor(maxTurns / 3));

  return [
    '## Turn budget',
    `You have a total budget of ${maxTurns} turns for this task. A "turn" is one round`,
    'of tool calls followed by your response. Plan your tool use accordingly:',
    '- Do not issue exploratory or speculative tool calls when you can act on what you know',
    '- If a search returns no results, try one alternative then move on — do not retry repeatedly',
    '- If a tool call returns an error or unexpected result, accept it and move on. Do not',
    '  retry the same tool with different parameters — note the failure in your final output',
    '- After completing your tool calls, produce your final structured response immediately.',
    '  Do not make additional tool calls unless genuinely necessary for the task',
    `- When you have fewer than ${proximityThreshold} turns remaining, your next response MUST include your`,
    '  final output, even if the task is incomplete. A partial result with noted gaps is',
    '  always better than silence',
  ].join('\n');
}
