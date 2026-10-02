// tests/scenarios/stub-layer.ts — the ExecutionLayer wrapper the scenario runner
// hands to createTestModeStack (#1956).
//
// The stack is booted once and reused across every case and run, so the stubs live
// on a controller: beginRun(stubs) installs a case's stubs, endRun() returns how each
// call was answered and clears them.
//
// Policy for a call:
//   1. A matching stub answers it. The real tool never runs.
//   2. No stub, and the tool must be stubbed (mustStub) → a <skill_error>. It never
//      falls through to the real tool. This is the fail-closed rule: a send, a write
//      or a delegation the case did not plan for is refused, not performed. "Write" is
//      judged by action_risk and by dangerous capabilities; a tool that misdeclares
//      both is still bounded by the test-mode stack (no transport, withheld services).
//   3. No stub, read-only tool → the real layer runs it (memory reads, date-resolve…).
//
// Everything other than invoke() goes to the real layer, so tool definitions, skill
// activation and the runtime's <task_error> formatting are production's.
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolRegistry } from '../../src/skills/registry.js';
import type { ToolResult } from '../../src/skills/types.js';
import { matchToolStub } from './stub-matcher.js';
import type { ToolStub } from './types.js';

/**
 * Tools that must be stubbed even though their manifest says action_risk: none.
 * `delegate` is "none" because routing itself has no external effect, but it wakes a
 * real specialist, and the suite tests the coordinator's decisions, not a specialist's.
 */
const ALWAYS_STUB: ReadonlySet<string> = new Set(['delegate']);

/**
 * Capabilities that let a tool act beyond its own inputs: re-invoke other tools
 * (approve-action holds the UNWRAPPED layer), send, resolve approvals, capture secrets.
 * Several such tools declare action_risk "none" and are harmless today only because
 * test mode withholds the service they need. Refusing on the capability keeps the
 * fail-closed guarantee from resting on what the stack happens to wire.
 */
const DANGEROUS_CAPABILITIES: ReadonlySet<string> = new Set([
  'executionLayer',
  'outboundGateway',
  'actionLogRepo',
  'secretCapture',
]);

/**
 * True when an unstubbed call to `toolName` must be refused rather than run.
 * `unavailable` names tools test mode cannot serve (missing capabilities): running one
 * only produces a failure production never shows, so it is refused — and counted as a
 * stub hole — instead.
 */
export function mustStub(
  toolName: string,
  registry: ToolRegistry,
  unavailable: ReadonlySet<string> = new Set(),
): boolean {
  if (ALWAYS_STUB.has(toolName) || unavailable.has(toolName)) return true;
  const tool = registry.get(toolName);
  // Not registered: the real layer answers "not found", which is what production does.
  if (!tool) return false;
  if ((tool.manifest.capabilities ?? []).some(c => DANGEROUS_CAPABILITIES.has(c))) return true;
  const risk = tool.manifest.action_risk;
  return typeof risk === 'number' ? risk > 0 : risk !== 'none';
}

export interface StubbedCall {
  agentId: string | undefined;
  /** The tool.invoke event id (InvokeOptions.parentEventId) — how capture joins the two views. */
  invokeEventId: string | undefined;
  toolName: string;
  input: Record<string, unknown>;
  disposition: 'stubbed' | 'passthrough' | 'refused';
}

export interface StubController {
  /** Wrap the real layer. Pass the result as createTestModeStack's wrapExecutionLayer. */
  wrap(layer: ExecutionLayer): ExecutionLayer;
  /**
   * Install a run's stubs for one conversation. Throws if a run is already open (runs
   * are sequential). A call from any other conversation — a timed-out turn from an
   * earlier run still going — is refused and not recorded: it must never be answered
   * by this run's stubs.
   */
  beginRun(stubs: Record<string, ToolStub[]>, conversationId: string): void;
  /** Close the run and return its calls in order. */
  endRun(): StubbedCall[];
  /** Calls refused because they came from a conversation other than the open run's. */
  readonly staleCalls: number;
}

function skillError(message: string): string {
  // Same envelope ExecutionLayer.wrapSkillError produces, so the runtime classifies
  // and formats a stubbed failure exactly as it would a real one.
  return `<skill_error>${message}</skill_error>`;
}

/**
 * `registry` is a getter because the stub layer is created inside createTestModeStack's
 * wrapExecutionLayer hook, before the stack (and its tool registry) is returned.
 */
export function createStubController(
  registry: () => ToolRegistry,
  unavailable: () => ReadonlySet<string> = () => new Set(),
): StubController {
  let stubs: Record<string, ToolStub[]> | null = null;
  let runConversationId: string | null = null;
  let calls: StubbedCall[] = [];
  let staleCalls = 0;

  const invokeStubbed = async (
    real: ExecutionLayer,
    args: Parameters<ExecutionLayer['invoke']>,
  ): Promise<ToolResult> => {
    const [toolName, input, , options] = args;

    if (stubs !== null && options?.conversationId !== undefined && options.conversationId !== runConversationId) {
      staleCalls++;
      return {
        success: false,
        error: skillError(`Tool '${toolName}' was called from a conversation outside the current scenario run; refused.`),
      };
    }

    const record = (disposition: StubbedCall['disposition']): void => {
      calls.push({
        agentId: options?.agentId,
        invokeEventId: options?.parentEventId,
        toolName,
        input: structuredClone(input),
        disposition,
      });
    };

    const stub = stubs ? matchToolStub(toolName, input, stubs) : undefined;
    if (stub) {
      record('stubbed');
      if (stub.error !== undefined) return { success: false, error: skillError(stub.error) };
      // Clone so a handler-side mutation in one run cannot leak into the next.
      return { success: true, data: structuredClone(stub.return ?? null) };
    }

    if (stubs === null || mustStub(toolName, registry(), unavailable())) {
      record('refused');
      return {
        success: false,
        error: skillError(
          stubs === null
            ? `Tool '${toolName}' was called outside a scenario run; the scenario layer refuses it.`
            : `Tool '${toolName}' has no stub for this call and is not read-only, so the scenario ` +
              'layer refused it (no stub matched these arguments).',
        ),
      };
    }

    record('passthrough');
    return real.invoke(...args);
  };

  return {
    wrap(layer) {
      return new Proxy(layer, {
        get(target, prop, receiver) {
          if (prop === 'invoke') {
            return (...args: Parameters<ExecutionLayer['invoke']>) => invokeStubbed(target, args);
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    },
    beginRun(next, conversationId) {
      if (stubs !== null) throw new Error('StubController.beginRun: a run is already open');
      stubs = next;
      runConversationId = conversationId;
      calls = [];
    },
    endRun() {
      const done = calls;
      stubs = null;
      runConversationId = null;
      calls = [];
      return done;
    },
    get staleCalls() {
      return staleCalls;
    },
  };
}
