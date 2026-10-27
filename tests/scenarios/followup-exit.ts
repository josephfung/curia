// followup-exit.ts — when a scenario follow-up may join at the exit hook.
//
// The runtime publishes llm.call and awaits every subscriber before it
// returns the response to the streaming loop. A text response's next step is
// the exit hook (beforeFinish → closeIfIdle). Publishing the follow-up inside
// that subscriber fills the queue before closeIfIdle, so the correction drains
// at `exit` instead of being missed. A tool_use response is not this signal:
// that follow-up waits until the first tool call is in flight.

import type { BusEvent, InjectionDrainPoint } from '../../src/bus/events.js';

/** The per-conversation follow-up the harness publishes from a text llm.call. */
export interface TextFinishSlot {
  agentId: string;
  /** True once, so a later text finish does not publish a second follow-up. */
  claim: () => boolean;
  publish: () => Promise<void>;
}

/**
 * The scenario harness's `llm.call` subscriber. A text finish publishes the
 * follow-up before the runtime's exit hook, so the drain is `exit`. A tool
 * call is not this signal. A throw is recorded on the run: the runtime
 * swallows a subscriber error and would otherwise miss the queue.
 */
export async function publishFollowupOnTextFinish(
  event: BusEvent,
  slots: ReadonlyMap<string, TextFinishSlot>,
  fail: (conversationId: string, err: unknown) => void,
): Promise<void> {
  if (event.type !== 'llm.call' || !isTextFinishCall(event)) return;
  const conversationId = event.payload.conversationId;
  const slot = slots.get(conversationId);
  if (!slot || event.payload.agentId !== slot.agentId) return;
  if (!slot.claim()) return;
  try {
    await slot.publish();
  } catch (err) {
    fail(conversationId, err);
  }
}

/** True when this llm.call is a text finish, the step immediately before the exit hook. */
export function isTextFinishCall(event: BusEvent): boolean {
  if (event.type !== 'llm.call') return false;
  const response = event.archive?.response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return false;
  return (response as { type?: unknown }).type === 'text';
}

/**
 * A follow-up drained before the model had chosen. `exit` and `round:N` are
 * the points the harness aims for, so they are not errors.
 */
export function turnStartDrainError(drainPoint: InjectionDrainPoint): string | undefined {
  if (drainPoint !== 'turn_start') return undefined;
  return 'follow-up drained at turn_start; the correction joined before the model had chosen';
}
