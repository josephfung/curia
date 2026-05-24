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
 *   - If you are within 3 turns of the limit and the task is incomplete, stop and produce
 *     a partial result or summary rather than continuing to tool-call into silence
 */
export function formatTurnBudgetBlock(maxTurns: number): string {
  return [
    '## Turn budget',
    `You have a total budget of ${maxTurns} turns for this task. A "turn" is one round`,
    'of tool calls followed by your response. Plan your tool use accordingly:',
    '- Do not issue exploratory or speculative tool calls when you can act on what you know',
    '- If a search returns no results, try one alternative then move on — do not retry repeatedly',
    '- If you are within 3 turns of the limit and the task is incomplete, stop and produce',
    '  a partial result or summary rather than continuing to tool-call into silence',
  ].join('\n');
}
