// tests/smoke/runner.ts
import { conversationIdFor, RESPONSE_TIMEOUT_MS, type CuriaHarness } from './harness.js';
import { resolveDatePlaceholders } from './date-placeholders.js';
import { resolvePrincipalPlaceholders, type PrincipalRef } from './fixtures.js';
import { mergeStubs } from './stub-layer.js';
import type { ToolStub } from '../scenarios/types.js';
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
    /** Who {{principal:…}} names in messages and fixtures. */
    principal?: PrincipalRef;
    /** Skip the warm-up turn (a retry pass runs on an already-warm stack). */
    warmUp?: boolean;
    /** The shared fixture world (stubs/office.yaml), tried after the case's own stubs. */
    defaultStubs?: Record<string, ToolStub[]>;
  },
): Promise<CaseExecution[]> {
  // Prime the stack so the first real test case doesn't pay cold-start cost.
  // warmUp() reports its own failure — harness failures surface through cases.
  if (options?.warmUp !== false) {
    options?.onWarmUp?.();
    await harness.warmUp();
  }

  const results: CaseExecution[] = [];

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    const responses: CapturedResponse[] = [];
    let error: string | undefined;

    // A turn that outlived its timeout (an earlier case's, or the warm-up's) keeps calling
    // tools; the stub layer would answer and record them as this case's, and its calendar
    // writes would show up in this case's listings. Wait for it, then start clean.
    const isolated = await harness.settle(RESPONSE_TIMEOUT_MS);
    harness.stubs.clear();
    harness.takeFallbacks();

    if (!isolated) {
      // Fail closed: running anyway could pass or fail this case on another case's activity.
      error = 'an earlier turn was still running after the timeout, so this case could not run in isolation';
    } else {
      try {
        await runSingleCase(harness, tc, responses, options?.defaultStubs ?? {}, options?.principal);
      } catch (err) {
        // Case-level failure (a turn timed out or errored). Turns that did complete are
        // kept for the report.
        error = err instanceof Error ? err.message : String(err);
      }
    }
    // Also stops this case's stubs answering a later case's calls.
    const agentCalls = harness.stubs.clear();
    // A specialist that fell back ran on a model the results are not labelled with.
    const fallbacks = harness.takeFallbacks();
    if (fallbacks.length > 0) error ??= `model fallback: ${fallbacks.join('; ')}`;

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
  defaultStubs: Record<string, ToolStub[]>,
  principal: PrincipalRef | undefined,
): Promise<void> {
  // Without a principal contact, a placeholder stays visible rather than silently becoming "".
  const withPrincipal = <T>(v: T): T => (principal ? resolvePrincipalPlaceholders(v, principal) : v);
  const conversationId = conversationIdFor(tc.sender);
  for (const turn of tc.turns) {
    // Delay between turns for multi-turn cases
    if (turn.delayMs) {
      await new Promise(resolve => setTimeout(resolve, turn.delayMs));
    }

    // Dates in fixtures and messages are relative to today in the principal's timezone,
    // as the agents see it, so a case never drifts into the past.
    // One "now" for the turn, so {{at:now+60m}} agrees between the message and the fixtures.
    const timezone = harness.stack.config.timezone;
    const now = new Date();
    harness.stubs.set(withPrincipal(resolveDatePlaceholders(mergeStubs(turn.toolStubs, tc.toolStubs, defaultStubs), timezone, now)));
    const prompt = withPrincipal(resolveDatePlaceholders(turn.content, timezone, now));
    const response = await harness.sendMessage({
      conversationId,
      content: prompt,
      sender: tc.sender,
    });

    responses.push({
      prompt,
      content: response.content,
      // The capture reads the coordinator's own agent.response, so this is exact.
      agentId: 'coordinator',
      durationMs: response.durationMs,
      toolCalls: response.toolCalls,
      ...(response.noReplyReason ? { noReplyReason: response.noReplyReason } : {}),
    });
  }
}
