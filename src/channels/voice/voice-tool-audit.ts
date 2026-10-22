// voice-tool-audit.ts — put a spoken turn's tool calls in audit_log (#1968).
//
// Text turns record every tool call: AgentRuntime publishes tool.invoke before the call
// and tool.result after. Voice bypasses AgentRuntime (VoiceRuntime runs its own
// streaming loop and calls ExecutionLayer.invoke through the tool bridge), and until
// #1968 it published neither. Nineteen production calls left no record of which tools
// ran, with what input, or what came back. This wraps each voice call in the same pair.
//
// The pair matches a text turn's so the audit queries, the console event stream and
// the timeline read voice like any other channel:
//   - agentId 'coordinator' and the voice conversation id, as ExecutionLayer.invoke
//     already receives them;
//   - taskEventId and routingTaskId are the voice session id, the stand-in for the
//     agent.task a spoken turn does not have;
//   - parentEventId is the turn's inbound.message (the session id when there is none),
//     and the tool.invoke id is what ExecutionLayer's own events chain under.
//
// Published from the agent layer, as AgentRuntime does: the voice turn is the
// coordinator answering. A publish failure propagates, as it does on the text path, so
// a tool never runs unaudited.
import type { EventBus } from '../../bus/bus.js';
import { createToolInvoke, createToolResult } from '../../bus/events.js';
import type { ToolCall } from '../../agents/llm/provider.js';
import type { ToolResult } from '../../skills/types.js';

export async function invokeVoiceToolAudited(params: {
  bus: EventBus;
  call: ToolCall;
  conversationId: string;
  sessionId: string;
  /**
   * The turn's inbound.message id. Absent for a turn with no utterance, or one whose
   * inbound.message failed to publish (so it has no audit row).
   */
  turnEventId?: string;
  /** Runs the tool. Receives the tool.invoke id, for ExecutionLayer's parentEventId. */
  invoke: (invokeEventId: string) => Promise<ToolResult>;
}): Promise<ToolResult> {
  const { bus, call, conversationId, sessionId } = params;
  const invokeEvent = createToolInvoke({
    agentId: 'coordinator',
    conversationId,
    toolName: call.name,
    input: call.input,
    taskEventId: sessionId,
    parentEventId: params.turnEventId ?? sessionId,
  });
  await bus.publish('agent', invokeEvent);

  const startedAt = Date.now();
  const result = await params.invoke(invokeEvent.id);
  await bus.publish(
    'agent',
    createToolResult({
      agentId: 'coordinator',
      conversationId,
      toolName: call.name,
      result,
      durationMs: Date.now() - startedAt,
      routingTaskId: sessionId,
      parentEventId: invokeEvent.id,
    }),
  );
  return result;
}
