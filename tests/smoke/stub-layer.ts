// tests/smoke/stub-layer.ts — tool stubs for smoke cases (#1956).
//
// Test mode cannot reach a calendar, a mailbox, the scheduler or the task store, so a
// case about them would only ever test "the system is down". A case's `tool_stubs`
// answer those calls with fixture data instead, for any agent — the coordinator or the
// specialist it delegates to — so the case tests what Curia does with the data.
//
// Unlike the scenario suite's fail-closed layer (tests/scenarios/stub-layer.ts), an
// unstubbed call here runs the real tool: smoke tests the whole stack, and it runs on
// a throwaway copy of the database (clone-db.ts), so a real database write lands nowhere
// that matters. Sends still cannot leave: the test-mode stack has no transport (#1966).
// Real reads can — web-fetch and web-search make real requests.
//
// A stubbed call is answered before the real ExecutionLayer, so its trust and autonomy
// checks do not run: a stubbed write "succeeds" even where production would gate it.
// Stub a write only where the case is about what Curia does next, not whether it may.
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolResult } from '../../src/skills/types.js';
import { matchToolStub } from '../scenarios/stub-matcher.js';
import { CalendarState, shapeStubResult } from './stub-filters.js';
import type { ToolStub } from '../scenarios/types.js';

/**
 * An answer computed at call time, for data a fixture cannot know in advance (the id of a
 * thread the harness opened). Returns undefined to leave the call to the stubs.
 */
export type CallAnswer = (input: Record<string, unknown>) => Promise<ToolResult | undefined>;

/** One tool call by any agent during a case, and how it was answered. */
export interface AgentToolCall {
  agentId: string | undefined;
  toolName: string;
  input: Record<string, unknown>;
  disposition: 'stubbed' | 'real';
  /** The stubbed or real outcome, for authoring stubs (`--show-calls`) and the results JSON. */
  success?: boolean;
}

export interface SmokeStubs {
  /** Wrap the real layer. Pass the result as createTestModeStack's wrapExecutionLayer. */
  wrap(layer: ExecutionLayer): ExecutionLayer;
  /**
   * Answer matching calls with these stubs until the next set() or clear(). Set before
   * each turn, so a multi-turn case can change what a tool returns between turns.
   */
  set(stubs: Record<string, ToolStub[]>): void;
  /**
   * Answer `toolName` calls with `answer` until the next clear(), before any stub. Kept
   * across set(), so it holds for every turn of the case.
   */
  answer(toolName: string, answer: CallAnswer): void;
  /** Stop stubbing and return every call made since the previous clear(). */
  clear(): AgentToolCall[];
}

function skillError(message: string): string {
  // Same envelope ExecutionLayer.wrapSkillError produces, so the runtime classifies
  // and formats a stubbed failure exactly as it would a real one.
  return `<skill_error>${message}</skill_error>`;
}

/**
 * Per-turn stubs first, then the case's, then the shared defaults: the first matching
 * stub wins, so a turn overrides its case and a case overrides the default world.
 */
export function mergeStubs(
  ...layers: Array<Record<string, ToolStub[]> | undefined>
): Record<string, ToolStub[]> {
  const merged: Record<string, ToolStub[]> = {};
  for (const layer of layers) {
    for (const [tool, stubs] of Object.entries(layer ?? {})) merged[tool] = [...(merged[tool] ?? []), ...stubs];
  }
  return merged;
}

export function createSmokeStubs(): SmokeStubs {
  let stubs: Record<string, ToolStub[]> = {};
  let answers = new Map<string, CallAnswer[]>();
  let calls: AgentToolCall[] = [];
  // What this case has written to the (stubbed) calendar, replayed onto its later reads.
  let calendar = new CalendarState();

  const invoke = async (real: ExecutionLayer, args: Parameters<ExecutionLayer['invoke']>): Promise<ToolResult> => {
    const [toolName, input, , options] = args;
    const record: AgentToolCall = {
      agentId: options?.agentId,
      toolName,
      input: structuredClone(input),
      disposition: 'real',
    };
    calls.push(record);

    for (const answer of answers.get(toolName) ?? []) {
      const result = await answer(structuredClone(input));
      if (result) {
        record.disposition = 'stubbed';
        record.success = result.success;
        return result;
      }
    }

    const stub = matchToolStub(toolName, input, stubs);
    if (stub) {
      record.disposition = 'stubbed';
      record.success = stub.error === undefined;
      if (stub.error !== undefined) return { success: false, error: skillError(stub.error) };
      // Clone so a handler-side mutation cannot change the fixture for a later call, then
      // answer the question asked (time range, search query, echoed inputs).
      return { success: true, data: shapeStubResult(toolName, structuredClone(stub.return ?? null), input, calendar) };
    }
    const result = await real.invoke(...args);
    record.success = result.success;
    return result;
  };

  return {
    wrap(layer) {
      return new Proxy(layer, {
        get(target, prop, receiver) {
          if (prop === 'invoke') {
            return (...args: Parameters<ExecutionLayer['invoke']>) => invoke(target, args);
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
    set(next) {
      stubs = next;
    },
    answer(toolName, answer) {
      answers.set(toolName, [...(answers.get(toolName) ?? []), answer]);
    },
    clear() {
      const done = calls;
      stubs = {};
      answers = new Map();
      calls = [];
      calendar = new CalendarState();
      return done;
    },
  };
}
