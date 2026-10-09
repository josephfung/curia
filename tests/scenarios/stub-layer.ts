// tests/scenarios/stub-layer.ts — the ExecutionLayer wrapper the scenario runner
// hands to createTestModeStack (#1956).
//
// The stack is booted once and reused across every case and run, so the stubs live
// on a controller: beginRun(stubs, conversationId) installs a run's stubs, endRun()
// returns how each call was answered and clears them. Several runs can be open at once
// (#1980): each call is answered by the run whose conversation made it. With stubbed
// delegation (the default) that is the run's own conversation. With real delegation
// (#2027) `delegate` runs, and each specialist works in a conversation the layer names
// for it (scenario-delegate-…) and files under the run: the specialist's calls get the
// same stubs and the same fail-closed policy as the coordinator's.
//
// Policy for a call:
//   1. A matching stub answers it. The real tool never runs.
//   2. No stub, and the tool must be stubbed (mustStub) → a <skill_error>. It never
//      falls through to the real tool. This is the fail-closed rule: a send, a write
//      or a delegation the case did not plan for is refused, not performed. "Write" is
//      judged by action_risk and by dangerous capabilities; a tool that misdeclares
//      both is still bounded by the test-mode stack (no transport, withheld services).
//   3. No stub, read-only tool → the real layer runs it (memory reads, date-resolve…).
//      So does a tool the stack serves from an MCP snapshot (#2024): its session returns
//      a canned result and reaches no account, whatever its action_risk says. The call
//      is recorded as `canned`, a stub hole like a refusal: the model acted on an empty
//      stand-in result, not on data the case chose. In a real-delegation run, so do
//      `delegate` and the outbound-context tools in REAL_IN_DELEGATION.
//
// Stubs can be scoped to an agent (`agent: calendar`); an unscoped stub answers every
// agent. Everything other than invoke() goes to the real layer, so tool definitions,
// skill activation and the runtime's <task_error> formatting are production's.
import { randomUUID } from 'node:crypto';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolRegistry } from '../../src/skills/registry.js';
import type { ToolResult } from '../../src/skills/types.js';
import { applyCaseWrites, recordedDraftRead, CaseToolState } from '../shared/tool-state.js';
import { emailAttachmentRefusal } from './attachment-guard.js';
import { matchToolStub } from './stub-matcher.js';
import type { ToolStub } from './types.js';

/**
 * Tools that must be stubbed even though their manifest says action_risk: none.
 * `delegate` is "none" because routing itself has no external effect, but it wakes a
 * real specialist, and the suite tests the coordinator's decisions, not a specialist's.
 */
const ALWAYS_STUB: ReadonlySet<string> = new Set(['delegate']);

/**
 * Tools that run for real, unstubbed, in a real-delegation run (#2027). `delegate` is the
 * point of the mode. The two outbound-context tools are how a specialist holds or clears
 * an entry the run seeded; they write only `outbound_context`, and the harness hands the
 * ExecutionLayer a view narrowed to the run's own entries (seed.ts:
 * scopedOutboundContext), so they cannot touch a real one. A stub still wins.
 * (context-bridge-release also needs the task repo, which test mode never has.)
 */
export const REAL_IN_DELEGATION: ReadonlySet<string> = new Set([
  'delegate',
  'context-bridge-keep-open',
  'context-bridge-clear',
]);

/**
 * conversation_id prefix of every specialist conversation in a real-delegation run. It
 * starts with `scenario-`, so the start-up sweep finds a crashed run's rows by it.
 */
export const SCENARIO_DELEGATE_PREFIX = 'scenario-delegate-';

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
 * stub hole — instead. `inert` names tools whose real handler reaches nothing (the
 * stack's snapshot-served MCP tools, #2024), so they run. `realDelegation` lets the
 * REAL_IN_DELEGATION tools run.
 */
export function mustStub(
  toolName: string,
  registry: ToolRegistry,
  unavailable: ReadonlySet<string> = new Set(),
  inert: ReadonlySet<string> = new Set(),
  options: { realDelegation?: boolean } = {},
): boolean {
  if (unavailable.has(toolName)) return true;
  if (options.realDelegation && REAL_IN_DELEGATION.has(toolName)) return false;
  if (ALWAYS_STUB.has(toolName)) return true;
  if (inert.has(toolName)) return false;
  const tool = registry.get(toolName);
  // Not registered: the real layer answers "not found", which is what production does.
  if (!tool) return false;
  const caps = [...(tool.manifest.capabilities ?? []), ...(tool.manifest.optional_capabilities ?? [])];
  if (caps.some(c => DANGEROUS_CAPABILITIES.has(c))) return true;
  const risk = tool.manifest.action_risk;
  return typeof risk === 'number' ? risk > 0 : risk !== 'none';
}

export interface StubbedCall {
  agentId: string | undefined;
  /** The tool.invoke event id (InvokeOptions.parentEventId) — how capture joins the two views. */
  invokeEventId: string | undefined;
  toolName: string;
  input: Record<string, unknown>;
  disposition: 'stubbed' | 'passthrough' | 'canned' | 'refused';
}

export interface StubController {
  /** Wrap the real layer. Pass the result as createTestModeStack's wrapExecutionLayer. */
  wrap(layer: ExecutionLayer): ExecutionLayer;
  /**
   * Install a run's stubs for its conversation. Throws if that conversation already has
   * an open run. A call from a conversation with no open run — a timed-out turn from a
   * run already closed — is refused and not recorded: it must never be answered by
   * another run's stubs. `realDelegation` runs `delegate` for real (#2027).
   */
  beginRun(stubs: Record<string, ToolStub[]>, conversationId: string, options?: { realDelegation?: boolean }): void;
  /** Close the conversation's run (and its specialists' conversations) and return its calls in order. */
  endRun(conversationId: string): StubbedCall[];
  /** The conversation of the open run `conversationId` belongs to: itself, or a specialist's run's root. */
  rootOf(conversationId: string): string | undefined;
  /**
   * The specialists an open run's `delegate` calls are still waiting on (#2027): a run
   * that times out with one is waiting on a slow specialist, not stuck.
   */
  pendingDelegations(conversationId: string): string[];
  /** Calls refused because they came from a conversation with no open run. */
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
  inert: () => ReadonlySet<string> = () => new Set(),
  hooks: {
    /** A real-delegation run started a specialist in `delegateConversationId` (#2027). */
    onDelegate?: (rootConversationId: string, delegateConversationId: string) => void;
  } = {},
): StubController {
  interface OpenRun {
    root: string;
    stubs: Record<string, ToolStub[]>;
    calls: StubbedCall[];
    tools: CaseToolState;
    realDelegation: boolean;
    /** Specialist conversations this run started, each also a key of `delegated`. */
    specialists: Set<string>;
    /** Real delegate calls not yet returned, one entry (the target agent) per call. */
    waiting: string[];
    /** Makes a model-chosen specialist conversation id unique to this run. */
    token: string;
  }
  const runs = new Map<string, OpenRun>();
  /** A specialist's conversation → the run it works for (#2027). */
  const delegated = new Map<string, OpenRun>();
  let staleCalls = 0;

  const runFor = (conversationId: string | undefined): OpenRun | undefined =>
    conversationId === undefined ? undefined : runs.get(conversationId) ?? delegated.get(conversationId);

  /**
   * The specialist's conversation: one the layer names, so its rows carry the suite's
   * prefix. A conversation_id the model chose keeps its identity within the run (two
   * delegations that share one still share it), but never across runs: a model that
   * picks the same id every run must not land in another run's conversation. This is the
   * isolation boundary, so an id another open run already owns (a token collision) is never
   * reused: the specialist gets a fresh conversation instead.
   */
  const specialistConversation = (run: OpenRun, given: unknown): string => {
    const fresh = (): string => `${SCENARIO_DELEGATE_PREFIX}${randomUUID()}`;
    if (typeof given !== 'string' || given.trim() === '') return fresh();
    if (run.specialists.has(given)) return given;
    const named = `${SCENARIO_DELEGATE_PREFIX}${run.token}-${given}`;
    const owner = delegated.get(named);
    return owner === undefined || owner === run ? named : fresh();
  };

  const invokeStubbed = async (
    real: ExecutionLayer,
    args: Parameters<ExecutionLayer['invoke']>,
  ): Promise<ToolResult> => {
    const [toolName, input, , options] = args;
    const run = runFor(options?.conversationId);

    if (!run && runs.size > 0) {
      staleCalls++;
      return {
        success: false,
        error: skillError(`Tool '${toolName}' was called from a conversation outside every open scenario run; refused.`),
      };
    }
    const stubs = run?.stubs ?? null;

    const record = (disposition: StubbedCall['disposition']): void => {
      run?.calls.push({
        agentId: options?.agentId,
        invokeEventId: options?.parentEventId,
        toolName,
        input: structuredClone(input),
        disposition,
      });
    };

    const stub = stubs ? matchToolStub(toolName, input, stubs, options?.agentId) : undefined;
    // Same write-then-read replay as smoke (#2074). A stub that names draft_id
    // still answers that ceo-inbox-read itself.
    if (run) {
      const draft = recordedDraftRead(toolName, input, run.tools, stub?.match);
      if (draft) {
        record('stubbed');
        return { success: true, data: draft };
      }
    }
    if (stub) {
      record('stubbed');
      if (stub.error !== undefined) return { success: false, error: skillError(stub.error) };
      // A success stub stands in for the send, not for the attachment check the
      // gateway runs first. A file_url outside the temp store is refused with
      // production's error, and recorded as stubbed: the model can recover, and
      // the miss is not a hole in the stub table (#2059).
      const attachmentError = emailAttachmentRefusal(toolName, input);
      if (attachmentError) return { success: false, error: skillError(attachmentError) };
      // Clone so a handler-side mutation in one run cannot leak into the next.
      const data = structuredClone(stub.return ?? null);
      if (run && data !== null && typeof data === 'object' && !Array.isArray(data)) {
        return { success: true, data: applyCaseWrites(toolName, data as Record<string, unknown>, input, run.tools) };
      }
      return { success: true, data };
    }

    if (stubs === null || mustStub(toolName, registry(), unavailable(), inert(), { realDelegation: run?.realDelegation })) {
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

    record(inert().has(toolName) ? 'canned' : 'passthrough');
    if (toolName === 'delegate' && run) {
      // Only a real-delegation run gets here: mustStub refuses delegate otherwise.
      const conversationId = specialistConversation(run, input['conversation_id']);
      if (!delegated.has(conversationId)) {
        delegated.set(conversationId, run);
        run.specialists.add(conversationId);
        hooks.onDelegate?.(run.root, conversationId);
      }
      const [, , caller] = args;
      const agent = typeof input['agent'] === 'string' ? input['agent'] : '(unnamed agent)';
      run.waiting.push(agent);
      try {
        return await real.invoke(toolName, { ...input, conversation_id: conversationId }, caller, options);
      } finally {
        // indexOf is -1 only on a harness bug; splice(-1) would drop another agent's wait.
        const i = run.waiting.indexOf(agent);
        if (i >= 0) run.waiting.splice(i, 1);
      }
    }
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
    beginRun(next, conversationId, options = {}) {
      if (runs.has(conversationId)) throw new Error(`StubController.beginRun: conversation ${conversationId} already has an open run`);
      runs.set(conversationId, {
        root: conversationId,
        stubs: next,
        calls: [],
        tools: new CaseToolState(),
        realDelegation: options.realDelegation === true,
        specialists: new Set(),
        waiting: [],
        token: randomUUID().slice(0, 8),
      });
    },
    endRun(conversationId) {
      const run = runs.get(conversationId);
      runs.delete(conversationId);
      for (const specialist of run?.specialists ?? []) delegated.delete(specialist);
      return run?.calls ?? [];
    },
    rootOf(conversationId) {
      return runFor(conversationId)?.root;
    },
    pendingDelegations(conversationId) {
      return [...(runs.get(conversationId)?.waiting ?? [])];
    },
    get staleCalls() {
      return staleCalls;
    },
  };
}
