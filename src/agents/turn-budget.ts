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
 *   - When you have fewer than 5 turns remaining, your next response MUST include your
 *     final output, even if the task is incomplete. A partial result with noted gaps is
 *     always better than silence
 *
 * The proximity threshold (the "fewer than N turns remaining" number) defaults to 5
 * but is clamped to at most half the budget so low-budget agents (maxTurns 3–4) aren't
 * told to finalize from turn 1. Formula: max(2, min(5, floor(maxTurns / 2))).
 */
export function formatTurnBudgetBlock(maxTurns: number): string {
  // Default threshold of 5 turns, but never more than half the budget so
  // low-turn agents still get usable tool turns. Min 2 so the guidance is
  // always present.
  const proximityThreshold = Math.max(2, Math.min(5, Math.floor(maxTurns / 2)));

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
