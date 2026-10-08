// tests/shared/turn-capture.ts — what one agent turn did, read off the bus.
// Shared by the scenario suite and smoke (#1956). The agent is the coordinator unless the
// caller names another: a smoke case can address a specialist directly (#1977).
//
// Capture listens as the `system` layer, which (unlike a `channel` subscription to
// outbound.message) also sees agent.response — so a NO_REPLY turn, or a reply Gate C
// holds for a non-principal sender, still ends the turn instead of timing out.
import type { EventBus } from '../../src/bus/bus.js';
import type {
  AgentErrorEvent,
  AgentResponseEvent,
  BusEvent,
  ModelFallbackEngagedEvent,
  OutboundNoReplyEvent,
  ToolInvokeEvent,
  ToolResultEvent,
} from '../../src/bus/events.js';
import type { DbPool } from '../../src/db/connection.js';
import type { TurnErrorKind } from './case-scope.js';

const COORDINATOR = 'coordinator';

/**
 * After agent.response, wait this long for the Dispatcher's follow-up events
 * (outbound.no_reply) before closing the turn. They are published in the same tick
 * chain, so a short settle is enough.
 */
const SETTLE_MS = 250;

/** One tool call by the captured agent, as the bus saw it. */
export interface ObservedToolCall {
  name: string;
  input: Record<string, unknown>;
  /** What the runtime handed back: data on success, the error string on failure. */
  result?: { success: true; data: unknown } | { success: false; error: string };
  /** The tool.invoke event id (the scenario suite joins it to the stub layer's record). */
  invokeEventId?: string;
}

export interface TurnOutcome {
  calls: ObservedToolCall[];
  /** The agent's agent.response content, with an exact NO_REPLY restored. */
  reply: string | null;
  /** Set when the Dispatcher suppressed delivery (outbound.no_reply reason). */
  noReplyReason?: string;
  /** Set when the turn could not complete (timeout, agent.error, model fallback, delivery failure). */
  error?: string;
  /** How it failed, when `error` is set: lets a harness tell a provider failure from the model's (#1980). */
  errorKind?: TurnErrorKind;
  /** The AgentError type of an agent.error or error response. */
  errorType?: string;
}

interface PendingTurn {
  /** The agent whose turn this is; every other agent's events on the conversation are ignored. */
  agentId: string;
  calls: ObservedToolCall[];
  invokeIndex: Map<string, number>;
  reply: string | null;
  noReplyReason?: string;
  error?: string;
  errorKind?: TurnErrorKind;
  errorType?: string;
  done: boolean;
  resolve: (outcome: TurnOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TurnCapture {
  /** Start waiting for the agent's (default: the coordinator's) next turn on this conversation. */
  waitFor(conversationId: string, timeoutMs: number, agentId?: string): Promise<TurnOutcome>;
  /** End a pending turn now with an error (its inbound could not be delivered). */
  fail(conversationId: string, err: unknown): void;
}

export function createTurnCapture(bus: EventBus): TurnCapture {
  const pending = new Map<string, PendingTurn>();

  const finish = (conversationId: string, p: PendingTurn): void => {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    // Let the Dispatcher's follow-up (outbound.no_reply) land before closing.
    setTimeout(() => {
      // A later turn on the same conversation may have registered during the settle
      // window (smoke runs several turns on one conversation); leave its entry alone.
      if (pending.get(conversationId) === p) pending.delete(conversationId);
      p.resolve({
        calls: p.calls,
        reply: p.reply,
        ...(p.noReplyReason ? { noReplyReason: p.noReplyReason } : {}),
        ...(p.error ? { error: p.error } : {}),
        ...(p.error && p.errorKind ? { errorKind: p.errorKind } : {}),
        ...(p.error && p.errorType ? { errorType: p.errorType } : {}),
      });
    }, SETTLE_MS);
  };

  // A conversation can carry several agents' turns at once: on a bullpen thread, the
  // agent that posted wakes up too if it is mentioned back. Only the awaited agent's count.
  const forAgent = (agentId: string, conversationId: string): PendingTurn | undefined => {
    const p = pending.get(conversationId);
    return p?.agentId === agentId ? p : undefined;
  };

  const on = (type: BusEvent['type'], handler: (event: BusEvent) => void): void => {
    bus.subscribe(type, 'system', async (event) => handler(event));
  };

  on('tool.invoke', (event) => {
    const { payload } = event as ToolInvokeEvent;
    const p = forAgent(payload.agentId, payload.conversationId);
    if (!p || p.done) return;
    p.invokeIndex.set(event.id, p.calls.length);
    p.calls.push({ name: payload.toolName, input: payload.input, invokeEventId: event.id });
  });

  on('tool.result', (event) => {
    const { payload, parentEventId } = event as ToolResultEvent;
    const p = forAgent(payload.agentId, payload.conversationId);
    if (!p || p.done || !parentEventId) return;
    const index = p.invokeIndex.get(parentEventId);
    if (index === undefined) return;
    const result = payload.result;
    p.calls[index]!.result = result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  });

  on('agent.response', (event) => {
    const { payload } = event as AgentResponseEvent;
    const p = forAgent(payload.agentId, payload.conversationId);
    if (!p || p.done) return; // a second response in the settle window must not replace the first
    // The runtime lifts an exact NO_REPLY out of the content before publishing (#1732):
    // what arrives is empty content with suppressDelivery. Put the sentinel back so
    // checks and the judge see the decision the model made. A narrated decline
    // ("NO_REPLY — automated notice") keeps its text and suppressDelivery, so it still
    // reads as not-exactly-NO_REPLY — which is the failure the check exists to catch.
    p.reply = payload.suppressDelivery && payload.content === '' ? 'NO_REPLY' : payload.content;
    if (payload.isError && p.error === undefined) {
      p.error = `${p.agentId} returned an error response: ${payload.content.slice(0, 200)}`;
      p.errorKind = 'error_response';
      if (payload.errorType) p.errorType = payload.errorType;
    }
    finish(payload.conversationId, p);
  });

  on('agent.error', (event) => {
    const { payload } = event as AgentErrorEvent;
    const p = forAgent(payload.agentId, payload.conversationId);
    if (!p) return;
    p.error = `agent.error ${payload.errorType}: ${payload.message}`;
    p.errorKind = 'agent_error';
    p.errorType = payload.errorType;
    finish(payload.conversationId, p);
  });

  // A fallback means the turn ran on a different model than the one the results are
  // labelled with — scoring it would credit or blame the wrong model.
  on('model.fallback', (event) => {
    const { payload } = event as ModelFallbackEngagedEvent;
    const p = forAgent(payload.agentId, payload.conversationId);
    if (!p || p.done) return;
    p.error = `model fallback: ${payload.failedModel} → ${payload.fallbackModel} (${payload.reason})`;
    p.errorKind = 'fallback';
  });

  on('outbound.no_reply', (event) => {
    const { payload } = event as OutboundNoReplyEvent;
    const p = pending.get(payload.conversationId);
    if (p) p.noReplyReason = payload.reason;
  });

  return {
    fail(conversationId, err) {
      const p = pending.get(conversationId);
      if (!p || p.done) return;
      p.error = `could not deliver the inbound: ${err instanceof Error ? err.message : String(err)}`;
      p.errorKind = 'delivery';
      finish(conversationId, p);
    },
    waitFor(conversationId, timeoutMs, agentId = COORDINATOR) {
      return new Promise((resolve) => {
        // Two live turns on one conversation can't be told apart: events are matched by
        // conversation id alone. Fail the newcomer closed rather than silently
        // replacing the entry and orphaning the first turn. (A finished turn still in
        // its settle window is fine: it no longer takes events.)
        const live = pending.get(conversationId);
        if (live && !live.done) {
          resolve({ calls: [], reply: null, error: `a turn is already pending on conversation ${conversationId}` });
          return;
        }
        const p: PendingTurn = {
          agentId,
          calls: [],
          invokeIndex: new Map(),
          reply: null,
          done: false,
          resolve,
          timer: setTimeout(() => {
            const who = agentId === COORDINATOR ? 'the coordinator' : agentId;
            p.error = `Timeout waiting for ${who} (${Math.round(timeoutMs / 1000)}s)`;
            p.errorKind = 'timeout';
            finish(conversationId, p);
          }, timeoutMs),
        };
        pending.set(conversationId, p);
      });
    },
  };
}

/**
 * Per-conversation rows the coordinator writes during a turn. Test suites delete them
 * afterwards: the runtime injects a sender's recent turns from OTHER conversations
 * (contact recent history), and every principal turn is attributed to the real
 * principal, so a kept test turn shows up in the next prompt — the real instance's
 * included. audit_log stays — it is append-only by design.
 */
export const CONVERSATION_TABLES = ['working_memory', 'conversation_checkpoints', 'conversation_resolved_entities'] as const;

export async function cleanupConversation(pool: DbPool, conversationId: string): Promise<void> {
  for (const table of CONVERSATION_TABLES) {
    // Table names come from the constant above, never from input.
    await pool.query(`DELETE FROM ${table} WHERE conversation_id = $1`, [conversationId]);
  }
}

/**
 * Delete conversation rows whose id starts with one of `prefixes` — what an interrupted
 * run left behind. Returns rows removed per table. Prefixes are the suites' own
 * conversation-id markers, never input.
 */
export async function sweepConversations(pool: DbPool, prefixes: readonly string[]): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  const patterns = prefixes.map(p => `${p}%`);
  for (const table of CONVERSATION_TABLES) {
    const result = await pool.query(`DELETE FROM ${table} WHERE conversation_id LIKE ANY($1::text[])`, [patterns]);
    removed[table] = result.rowCount ?? 0;
  }
  return removed;
}

/**
 * The working-memory view a test suite hands the stack: contact recent history withheld,
 * so every case starts from a clean slate. On the dev database that recall surfaces other
 * test runs' and the real principal's turns (it once turned a reply-shaped "Yes, go
 * ahead." into a real pending research ask).
 */
export function withoutRecentHistory<T extends { getContactRecentHistory: (...args: never[]) => unknown }>(memory: T): T {
  return Object.assign(Object.create(memory) as T, {
    getContactRecentHistory: async () => [],
  });
}
