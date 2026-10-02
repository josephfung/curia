// tests/smoke/stub-layer.ts — tool stubs for smoke cases (#1956).
//
// Test mode cannot reach a calendar, a mailbox, the scheduler or the task store, so a
// case about them would only ever test "the system is down". A case's `tool_stubs`
// answer those calls with fixture data instead, for any agent — the coordinator or the
// specialist it delegates to — so the case tests what Curia does with the data.
//
// Unlike the scenario suite's fail-closed layer (tests/scenarios/stub-layer.ts), an
// unstubbed call here runs the real tool: smoke tests the whole stack, and it runs on
// a throwaway copy of the database (clone-db.ts), so a real write lands nowhere that
// matters. Sends still cannot leave: the test-mode stack has no transport (#1966).
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolResult } from '../../src/skills/types.js';
import { matchToolStub } from '../scenarios/stub-matcher.js';
import type { ToolStub } from '../scenarios/types.js';

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
  /** Stop stubbing and return every call made since the previous clear(). */
  clear(): AgentToolCall[];
}

function skillError(message: string): string {
  // Same envelope ExecutionLayer.wrapSkillError produces, so the runtime classifies
  // and formats a stubbed failure exactly as it would a real one.
  return `<skill_error>${message}</skill_error>`;
}

/**
 * Per-turn stubs first, then the case's: the first matching stub wins, so a turn can
 * override a case-level answer for the same tool.
 */
export function mergeStubs(
  turn: Record<string, ToolStub[]> | undefined,
  base: Record<string, ToolStub[]>,
): Record<string, ToolStub[]> {
  if (!turn) return base;
  const merged: Record<string, ToolStub[]> = { ...base };
  for (const [tool, stubs] of Object.entries(turn)) merged[tool] = [...stubs, ...(base[tool] ?? [])];
  return merged;
}

export function createSmokeStubs(): SmokeStubs {
  let stubs: Record<string, ToolStub[]> = {};
  let calls: AgentToolCall[] = [];

  const invoke = async (real: ExecutionLayer, args: Parameters<ExecutionLayer['invoke']>): Promise<ToolResult> => {
    const [toolName, input, , options] = args;
    const record: AgentToolCall = {
      agentId: options?.agentId,
      toolName,
      input: structuredClone(input),
      disposition: 'real',
    };
    calls.push(record);

    const stub = matchToolStub(toolName, input, stubs);
    if (stub) {
      record.disposition = 'stubbed';
      record.success = stub.error === undefined;
      if (stub.error !== undefined) return { success: false, error: skillError(stub.error) };
      // Clone so a handler-side mutation cannot change the fixture for a later call.
      return { success: true, data: structuredClone(stub.return ?? null) };
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
    clear() {
      const done = calls;
      stubs = {};
      calls = [];
      return done;
    },
  };
}
