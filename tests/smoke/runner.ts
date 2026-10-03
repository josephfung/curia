// tests/smoke/runner.ts
import { conversationIdFor, RESPONSE_TIMEOUT_MS, type CuriaHarness, type TargetThread } from './harness.js';
import { resolveDatePlaceholders } from './date-placeholders.js';
import { resolvePrincipalPlaceholders, type PrincipalRef } from './fixtures.js';
import { mergeStubs } from './stub-layer.js';
import type { ToolStub } from '../scenarios/types.js';
import type { CaseTarget, TestCase, CaseExecution, CapturedResponse } from './types.js';

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
    // A targeted case's topic and opening, placeholders resolved: what the agent and the
    // judge both see. Dates resolve against the moment the case starts.
    const target = tc.target
      ? withPrincipalOf(options?.principal)(resolveDatePlaceholders(tc.target, harness.stack.config.timezone, new Date()))
      : undefined;

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
        await runSingleCase(harness, tc, target, responses, options?.defaultStubs ?? {}, options?.principal);
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

    const execution: CaseExecution = {
      testCase: tc,
      responses,
      agentCalls,
      ...(target ? { target } : {}),
      ...(error ? { error } : {}),
    };
    results.push(execution);
    options?.onCaseComplete?.(execution, i + 1, cases.length);
  }

  return results;
}

/** Resolve {{principal:…}}. Without a principal contact, a placeholder stays visible rather than silently becoming "". */
function withPrincipalOf(principal: PrincipalRef | undefined): <T>(v: T) => T {
  return <T>(v: T): T => (principal ? resolvePrincipalPlaceholders(v, principal) : v);
}

async function runSingleCase(
  harness: CuriaHarness,
  tc: TestCase,
  target: CaseTarget | undefined,
  responses: CapturedResponse[],
  defaultStubs: Record<string, ToolStub[]>,
  principal: PrincipalRef | undefined,
): Promise<void> {
  const withPrincipal = withPrincipalOf(principal);
  // A targeted case talks on its own bullpen thread; the thread id is the conversation.
  let thread: TargetThread | undefined;
  if (target) thread = await harness.openTargetThread(target);
  let turnError: unknown;
  try {
    await runTurns(harness, tc, responses, defaultStubs, withPrincipal, target && thread ? { spec: target, thread } : undefined);
  } catch (err) {
    turnError = err;
  }
  // Close even after a failed turn: an open thread would be injected into the agent's
  // prompt in every later case. A failure here fails this case, but never replaces the
  // turn's own error, which is the more useful of the two.
  if (target && thread) {
    try {
      await harness.closeTargetThread(target, thread);
    } catch (err) {
      const detail = `could not close the case's bullpen thread ${thread.threadId}: ${err instanceof Error ? err.message : String(err)}`;
      if (turnError === undefined) throw new Error(detail);
      process.stderr.write(`  [WARN] ${detail}\n`);
    }
  }
  if (turnError !== undefined) throw turnError;
}

async function runTurns(
  harness: CuriaHarness,
  tc: TestCase,
  responses: CapturedResponse[],
  defaultStubs: Record<string, ToolStub[]>,
  withPrincipal: <T>(v: T) => T,
  target: Parameters<CuriaHarness['sendMessage']>[0]['target'],
): Promise<void> {
  const conversationId = target ? target.thread.threadId : conversationIdFor(tc.sender);
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
      ...(target ? { target } : {}),
    });

    responses.push({
      prompt,
      content: response.content,
      // The capture reads that agent's own agent.response, so this is exact.
      agentId: target?.spec.agent ?? 'coordinator',
      durationMs: response.durationMs,
      toolCalls: response.toolCalls,
      ...(response.noReplyReason ? { noReplyReason: response.noReplyReason } : {}),
    });
  }
}
