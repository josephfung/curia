// tests/smoke/runner.ts
import { randomUUID } from 'node:crypto';
import type { CuriaHarness } from './harness.js';
import type { TestCase, CaseExecution, CapturedResponse } from './types.js';

/**
 * Execute all test cases against a live Curia harness.
 * Each case gets a unique conversationId to avoid cross-contamination.
 * Multi-turn cases send turns sequentially with configured delays.
 */
export async function runTestCases(
  harness: CuriaHarness,
  cases: TestCase[],
  options?: { onCaseComplete?: (exec: CaseExecution, index: number, total: number) => void },
): Promise<CaseExecution[]> {
  const results: CaseExecution[] = [];

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    let execution: CaseExecution;

    try {
      execution = await runSingleCase(harness, tc);
    } catch (err) {
      // Case-level failure (e.g., all turns timed out)
      execution = {
        testCase: tc,
        responses: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    results.push(execution);
    options?.onCaseComplete?.(execution, i + 1, cases.length);
  }

  return results;
}

async function runSingleCase(
  harness: CuriaHarness,
  tc: TestCase,
): Promise<CaseExecution> {
  const conversationId = `smoke-${randomUUID()}`;
  const responses: CapturedResponse[] = [];

  for (const turn of tc.turns) {
    // Delay between turns for multi-turn cases
    if (turn.delayMs) {
      await new Promise(resolve => setTimeout(resolve, turn.delayMs));
    }

    const response = await harness.sendMessage({
      conversationId,
      content: turn.content,
    });

    responses.push({
      content: response.content,
      agentId: 'coordinator', // TODO: capture actual agent from bus events
      durationMs: response.durationMs,
    });
  }

  return { testCase: tc, responses };
}
