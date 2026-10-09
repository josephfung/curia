// tests/scenarios/delegation-capture.ts — what the specialists did in a run with real
// delegation (#2027), read off the bus.
//
// Turn capture (tests/shared/turn-capture.ts) follows one agent on one conversation: the
// coordinator on the run's. A real specialist works in a conversation of its own, which
// the stub layer names and files under the run (stub-layer.ts: rootOf). This listens to
// those conversations: each specialist's brief (the agent.task it received), its tool
// calls and their results, and its response. It also numbers every tool.invoke of the
// run, the coordinator's included, so the harness can put all calls in the order they
// were made: a specialist's calls happen while the coordinator's `delegate` call waits.
//
// It must subscribe before any agent runtime (createTestModeStack's observeBus): the bus
// delivers to subscribers in order and awaits each, so a later subscriber would see a
// specialist's agent.task only after the specialist had finished with it.
import type { EventBus } from '../../src/bus/bus.js';
import type {
  AgentErrorEvent,
  AgentResponseEvent,
  AgentTaskEvent,
  BusEvent,
  ToolInvokeEvent,
  ToolResultEvent,
} from '../../src/bus/events.js';
import type { ObservedToolCall } from '../shared/turn-capture.js';
import type { DelegationRecord } from './types.js';

/** A specialist's call, as the bus saw it, with its place in the run's call order. */
export interface SpecialistCall extends ObservedToolCall {
  agentId: string;
  seq: number;
}

export interface DelegationTrace {
  /** Run-wide call order, by tool.invoke event id: the coordinator's calls and the specialists'. */
  seqByInvoke: Map<string, number>;
  /** Specialists' calls, in order. */
  calls: SpecialistCall[];
  /** One per specialist run, in the order they started. */
  delegations: DelegationRecord[];
}

interface OpenTrace extends DelegationTrace {
  /** Specialist task event id → its delegation record. */
  byTask: Map<string, DelegationRecord>;
  /** Specialist tool.invoke event id → index in `calls`. */
  callIndex: Map<string, number>;
}

export interface DelegationCapture {
  /** Start recording for the run whose coordinator works in `rootConversationId`. */
  begin(rootConversationId: string): void;
  /** Stop recording and return what the run's specialists did. */
  end(rootConversationId: string): DelegationTrace;
}

/**
 * `rootOf` maps a conversation to its open run (the stub layer's view). `onLate` is called
 * when a specialist conversation whose run already ended finishes a turn: what it wrote
 * after the run's cleanup must be removed again.
 */
export function createDelegationCapture(
  bus: EventBus,
  rootOf: (conversationId: string) => string | undefined,
  onLate: (conversationId: string) => void = () => {},
): DelegationCapture {
  const traces = new Map<string, OpenTrace>();
  /** Specialist conversations of runs that have ended, kept so a late finish is noticed. */
  const ended = new Set<string>();
  let seq = 0;

  /** The open trace a specialist conversation belongs to; undefined for a run's own conversation. */
  const specialistTrace = (conversationId: string): OpenTrace | undefined => {
    const root = rootOf(conversationId);
    return root !== undefined && root !== conversationId ? traces.get(root) : undefined;
  };

  const on = (type: BusEvent['type'], handler: (event: BusEvent) => void): void => {
    bus.subscribe(type, 'system', async (event) => handler(event));
  };

  on('agent.task', (event) => {
    const { payload } = event as AgentTaskEvent;
    const trace = specialistTrace(payload.conversationId);
    if (!trace) return;
    const record: DelegationRecord = {
      agentId: payload.agentId,
      conversationId: payload.conversationId,
      brief: payload.content,
      response: null,
      outcome: 'in_flight',
    };
    trace.byTask.set(event.id, record);
    trace.delegations.push(record);
  });

  on('tool.invoke', (event) => {
    const { payload } = event as ToolInvokeEvent;
    const root = rootOf(payload.conversationId);
    const trace = root !== undefined ? traces.get(root) : undefined;
    if (!trace) return;
    const n = ++seq;
    trace.seqByInvoke.set(event.id, n);
    if (root === payload.conversationId) return; // the coordinator's: turn capture has it
    trace.callIndex.set(event.id, trace.calls.length);
    trace.calls.push({ agentId: payload.agentId, name: payload.toolName, input: payload.input, invokeEventId: event.id, seq: n });
  });

  on('tool.result', (event) => {
    const { payload, parentEventId } = event as ToolResultEvent;
    const trace = specialistTrace(payload.conversationId);
    const index = trace && parentEventId ? trace.callIndex.get(parentEventId) : undefined;
    if (index === undefined) return;
    const result = payload.result;
    trace!.calls[index]!.result = result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  });

  on('agent.response', (event) => {
    const { payload, parentEventId } = event as AgentResponseEvent;
    if (ended.has(payload.conversationId)) {
      onLate(payload.conversationId);
      return;
    }
    const record = parentEventId ? specialistTrace(payload.conversationId)?.byTask.get(parentEventId) : undefined;
    if (!record || record.outcome !== 'in_flight') return;
    record.response = payload.content;
    record.outcome = payload.isError ? 'error' : 'answered';
  });

  on('agent.error', (event) => {
    const { payload } = event as AgentErrorEvent;
    if (ended.has(payload.conversationId)) {
      onLate(payload.conversationId);
      return;
    }
    const trace = specialistTrace(payload.conversationId);
    for (const record of trace?.delegations ?? []) {
      if (record.conversationId === payload.conversationId && record.outcome === 'in_flight') {
        record.outcome = 'error';
        record.response = `agent.error ${payload.errorType}: ${payload.message}`;
      }
    }
  });

  return {
    begin(rootConversationId) {
      traces.set(rootConversationId, {
        seqByInvoke: new Map(),
        calls: [],
        delegations: [],
        byTask: new Map(),
        callIndex: new Map(),
      });
    },
    end(rootConversationId) {
      const trace = traces.get(rootConversationId);
      traces.delete(rootConversationId);
      if (!trace) return { seqByInvoke: new Map(), calls: [], delegations: [] };
      for (const d of trace.delegations) {
        if (d.outcome === 'in_flight') ended.add(d.conversationId);
      }
      return { seqByInvoke: trace.seqByInvoke, calls: trace.calls, delegations: trace.delegations };
    },
  };
}
