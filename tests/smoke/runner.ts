// tests/smoke/runner.ts
import { conversationIdFor, TurnError, type CuriaHarness, type TargetThread } from './harness.js';
import { resolveDatePlaceholders } from '../shared/date-placeholders.js';
import { resolvePrincipalPlaceholders, type PrincipalRef } from './fixtures.js';
import { mergeStubs, newSmokeCase, officeFor } from './stub-layer.js';
import {
  PROVIDER_RETRIES,
  providerFailure,
  runConcurrently,
  stalledCallMs,
  type TurnErrorKind,
} from '../shared/case-scope.js';
import { sumBreakdowns, type UsageBreakdown } from '../shared/usage.js';
import type { ToolStub } from '../scenarios/types.js';
import type { CaseTarget, TestCase, CaseExecution, CapturedResponse } from './types.js';
import { resolveJudgedText } from './loader.js';

/**
 * After an attempt ends and is cancelled, how long to wait for its leftover work to wind
 * down before reading its spend. A cancelled turn ends at its next model call, so this is
 * mostly the one call in flight; one that runs longer is left to shutdown, and its spend
 * is reported as outside any case.
 */
const CANCEL_SETTLE_MS = 30_000;

export interface RunOptions {
  /** Called as each case finishes, `index` counting completions (order varies with concurrency). */
  onCaseComplete?: (exec: CaseExecution, index: number, total: number) => void;
  /** Called when an attempt is thrown away for a provider failure and run again. */
  onProviderRetry?: (testCase: TestCase, reason: string) => void;
  onWarmUp?: () => void;
  /** Who {{principal:…}} names in messages and fixtures. */
  principal?: PrincipalRef;
  /** Skip the warm-up turn (a retry pass runs on an already-warm stack). */
  warmUp?: boolean;
  /** The shared fixture world (stubs/office.yaml), tried after the case's own stubs. */
  defaultStubs?: Record<string, ToolStub[]>;
  /** Cases run at once (default 1). */
  concurrency?: number;
}

/**
 * Execute test cases against a live Curia harness, `concurrency` at a time; results keep
 * the input order. Sends a warm-up message first to absorb cold-start latency (DB pool
 * warm-up, first model API round-trip). Each case runs in its own case context with its
 * own conversation (harness.ts), so concurrent cases cannot see each other's stubs, calls
 * or turns. Multi-turn cases send turns sequentially with configured delays.
 *
 * Returns the executions and what the warm-up spent.
 */
export async function runTestCases(
  harness: CuriaHarness,
  cases: TestCase[],
  options: RunOptions = {},
): Promise<{ executions: CaseExecution[]; warmUpUsage?: UsageBreakdown }> {
  // Prime the stack so the first real test case doesn't pay cold-start cost.
  // warmUp() reports its own failure — harness failures surface through cases.
  let warmUpUsage: UsageBreakdown | undefined;
  if (options.warmUp !== false) {
    options.onWarmUp?.();
    warmUpUsage = await harness.warmUp();
  }

  let completed = 0;
  const executions = await runConcurrently(cases, options.concurrency ?? 1, async (tc) => {
    const execution = await runWithProviderRetries(harness, tc, options);
    options.onCaseComplete?.(execution, ++completed, cases.length);
    return execution;
  });
  return { executions, ...(warmUpUsage ? { warmUpUsage } : {}) };
}

/**
 * Run a case, re-running it up to PROVIDER_RETRIES times when an attempt fails for a
 * provider reason (case-scope.ts: providerFailure). Those re-runs do not use the case's
 * one gated retry (cli.ts): a stalled provider is not evidence about the model (#1980).
 * The result is the last attempt's, with every attempt's spend and each retry's reason.
 */
async function runWithProviderRetries(harness: CuriaHarness, tc: TestCase, options: RunOptions): Promise<CaseExecution> {
  const providerRetries: string[] = [];
  const spent: UsageBreakdown[] = [];
  for (;;) {
    const { execution, providerReason } = await runAttempt(harness, tc, options);
    spent.push(execution.usage);
    if (providerReason && providerRetries.length < PROVIDER_RETRIES) {
      providerRetries.push(providerReason);
      options.onProviderRetry?.(tc, providerReason);
      continue;
    }
    return { ...execution, usage: sumBreakdowns(spent), providerRetries };
  }
}

/** One attempt at a case, in a fresh case context. */
async function runAttempt(
  harness: CuriaHarness,
  tc: TestCase,
  options: RunOptions,
): Promise<{ execution: CaseExecution; providerReason?: string }> {
  const state = newSmokeCase(tc.name, harness.stack.config.timezone);
  for (const c of tc.config ?? []) state.configs.set(`${c.namespace}/${c.key}`, c.value);
  return harness.runInCase(state, async () => {
    const responses: CapturedResponse[] = [];
    let error: string | undefined;
    let errorKind: TurnErrorKind | undefined;
    let errorType: string | undefined;
    // A targeted case's topic and opening, placeholders resolved: what the agent and the
    // judge both see. Dates resolve on the case clock below. Resolved inside
    // the try below, so a bad placeholder fails this case, not the whole run.
    let target: CaseTarget | undefined;
    // One clock for everything the judge reads beside the first message: the target, the
    // first turn's message and fixtures, and the judge's expectations. The first turn's delay
    // is waited out before it is read, so all four name the same day even when that delay
    // crosses local midnight. Later turns keep their own clocks ({{at:now…}} is per turn).
    const firstDelayMs = tc.turns[0]?.delayMs;
    if (firstDelayMs) await new Promise(resolve => setTimeout(resolve, firstDelayMs));
    const caseClock = new Date();

    try {
      target = tc.target
        ? withPrincipalOf(options.principal)(resolveDatePlaceholders(tc.target, harness.stack.config.timezone, caseClock))
        : undefined;
      await runSingleCase(harness, tc, target, responses, options.defaultStubs ?? {}, options.principal, caseClock);
    } catch (err) {
      // Case-level failure (a turn timed out or errored). Turns that did complete are
      // kept for the report.
      error = err instanceof Error ? err.message : String(err);
      if (err instanceof TurnError) {
        errorKind = err.kind;
        errorType = err.errorType;
      }
    }
    // Measured now, while a stalled call is still in flight.
    const stalled = stalledCallMs(state);

    // Whatever this case still has running must stop, whether it passed or failed: it has
    // its result, and leftover work (a timed-out turn, a specialist past its delegate
    // timeout) would otherwise go on spending and calling tools — for real, once the
    // stubs below are cleared — beside the cases still running.
    state.cancelled = true;
    if (!(await harness.settle(state, CANCEL_SETTLE_MS))) {
      process.stderr.write(`  [WARN] '${tc.name}': a turn was still running ${CANCEL_SETTLE_MS / 1000}s after the case ended; its later spend is counted outside any case\n`);
    }
    // Also stops this case's stubs answering anything later.
    const agentCalls = harness.stubs.clear();
    // A specialist that fell back ran on a model the results are not labelled with. Only
    // the failure when nothing else failed first: a model failure must not be re-run as a
    // provider one because some specialist also fell back.
    if (state.fallbacks.length > 0 && error === undefined) {
      error = `model fallback: ${state.fallbacks.join('; ')}`;
      errorKind = 'fallback';
    }
    const usage = state.usage.snapshot();
    state.closed = true;

    // What the judge rates against. The loader has already checked these placeholders, so a
    // throw here is unexpected: the case then fails with that error and keeps its raw text.
    let judged: TestCase = tc;
    try {
      judged = resolveJudgedText(tc, harness.stack.config.timezone, caseClock, withPrincipalOf(options.principal));
    } catch (err) {
      error ??= `could not resolve the judge's expectations: ${err instanceof Error ? err.message : String(err)}`;
    }

    const execution: CaseExecution = {
      testCase: judged,
      responses,
      agentCalls,
      ...(target ? { target } : {}),
      ...(error ? { error } : {}),
      usage,
      providerRetries: [],
      today: todayIn(harness.stack.config.timezone, caseClock),
    };
    const providerReason = error
      ? providerFailure({ ...(errorKind ? { kind: errorKind } : {}), ...(errorType ? { errorType } : {}), stalledCallMs: stalled })
      : undefined;
    return { execution, ...(providerReason ? { providerReason } : {}) };
  });
}

/** e.g. "Friday, October 2, 2026 (America/Toronto)": the date at `at` in the principal's timezone. */
export function todayIn(timezone: string, at: Date = new Date()): string {
  const date = at.toLocaleDateString('en-US', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return `${date} (${timezone})`;
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
  caseClock: Date,
): Promise<void> {
  const withPrincipal = withPrincipalOf(principal);
  // A targeted case talks on its own bullpen thread; the thread id is the conversation.
  let thread: TargetThread | undefined;
  if (target) thread = await harness.openTargetThread(target);
  let turnError: unknown;
  try {
    await runTurns(harness, tc, responses, defaultStubs, withPrincipal, target && thread ? { spec: target, thread } : undefined, caseClock);
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
  /** The first turn's clock, its delay already waited out by the caller (runAttempt). */
  caseClock: Date,
): Promise<void> {
  const conversationId = target ? target.thread.threadId : conversationIdFor(tc.sender);
  for (const [index, turn] of tc.turns.entries()) {
    // Delay between turns for multi-turn cases. The first turn's was waited out before the
    // case clock was read, so it is not waited again.
    if (index > 0 && turn.delayMs) {
      await new Promise(resolve => setTimeout(resolve, turn.delayMs));
    }

    // Dates in fixtures and messages are relative to today in the principal's timezone,
    // as the agents see it, so a case never drifts into the past.
    // One "now" for the turn, so {{at:now+60m}} agrees between the message and the fixtures.
    const timezone = harness.stack.config.timezone;
    const now = index === 0 ? caseClock : new Date();
    harness.stubs.set(withPrincipal(resolveDatePlaceholders(mergeStubs(turn.toolStubs, tc.toolStubs, officeFor(tc, defaultStubs)), timezone, now)));
    const prompt = withPrincipal(resolveDatePlaceholders(turn.content, timezone, now));
    const response = await harness.sendMessage({
      conversationId,
      content: prompt,
      sender: tc.sender,
      ...(target ? { target } : {}),
      ...(tc.timeoutSeconds !== undefined ? { timeoutMs: tc.timeoutSeconds * 1000 } : {}),
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
