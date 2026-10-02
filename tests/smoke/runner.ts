// tests/smoke/runner.ts
import { conversationIdFor, type CuriaHarness } from './harness.js';
import { resolveDatePlaceholders } from './date-placeholders.js';
import { mergeStubs } from './stub-layer.js';
import type { TestCase, CaseExecution, CapturedResponse } from './types.js';

/**
 * Execute all test cases against a live Curia harness.
 * Sends a warm-up message first to absorb cold-start latency (DB pool warm-up,
 * first model API round-trip), then runs each case with a unique
 * conversationId to avoid cross-contamination.
 * Multi-turn cases send turns sequentially with configured delays.
 */
export async function runTestCases(
  harness: CuriaHarness,
  cases: TestCase[],
  options?: {
    onCaseComplete?: (exec: CaseExecution, index: number, total: number) => void;
    onWarmUp?: () => void;
  },
): Promise<CaseExecution[]> {
  // Prime the stack so the first real test case doesn't pay cold-start cost.
  // warmUp() reports its own failure — harness failures surface through cases.
  options?.onWarmUp?.();
  await harness.warmUp();

  const results: CaseExecution[] = [];

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    const responses: CapturedResponse[] = [];
    let error: string | undefined;

    try {
      await runSingleCase(harness, tc, responses);
    } catch (err) {
      // Case-level failure (a turn timed out or errored). Turns that did complete are
      // kept for the report.
      error = err instanceof Error ? err.message : String(err);
    }
    // Also stops this case's stubs answering a later case's calls.
    const agentCalls = harness.stubs.clear();

    const execution: CaseExecution = { testCase: tc, responses, agentCalls, ...(error ? { error } : {}) };
    results.push(execution);
    options?.onCaseComplete?.(execution, i + 1, cases.length);
  }

  return results;
}

async function runSingleCase(
  harness: CuriaHarness,
  tc: TestCase,
  responses: CapturedResponse[],
): Promise<void> {
  const conversationId = conversationIdFor(tc.sender);
  for (const turn of tc.turns) {
    // Delay between turns for multi-turn cases
    if (turn.delayMs) {
      await new Promise(resolve => setTimeout(resolve, turn.delayMs));
    }

    // Dates in fixtures are relative to today in the principal's timezone, as the agents see it.
    harness.stubs.set(resolveDatePlaceholders(mergeStubs(turn.toolStubs, tc.toolStubs), harness.stack.config.timezone));
    const response = await harness.sendMessage({
      conversationId,
      content: turn.content,
      sender: tc.sender,
    });

    responses.push({
      content: response.content,
      // The capture reads the coordinator's own agent.response, so this is exact.
      agentId: 'coordinator',
      durationMs: response.durationMs,
      toolCalls: response.toolCalls,
    });
  }
}
