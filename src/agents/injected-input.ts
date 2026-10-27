// Frame a same-contact follow-up for the model (#2018).
//
// The text is a user message, never a tool_result. A tool_result is tied to a
// tool_use id; putting someone's words there would look like a tool reply and
// could be glued onto the wrong turn. The body stays in its own text block.
//
// The guidance block is the same renderer the turn-opening path uses. This
// file does not copy those strings. Nothing here is added to an agent prompt.

import type { Message } from './llm/provider.js';
import { parseTurnGuidanceKeys, renderTurnGuidance } from './prompts/turn-guidance.js';
import { isPlausibleUnixSeconds, toLocalIso } from '../time/timestamp.js';

export interface FrameInjectedInput {
  senderLabel?: string;
  channelId: string;
  /** ISO-8601, or unix seconds as a decimal string. */
  receivedAt: string;
  /** Task content after the dispatcher's preambles. Working memory stores the raw text separately. */
  content: string;
  turnGuidance?: readonly string[];
}

function unixSeconds(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const asNumber = Number(value);
    return isPlausibleUnixSeconds(asNumber) ? asNumber : null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.floor(parsed / 1000);
  return isPlausibleUnixSeconds(seconds) ? seconds : null;
}

function receivedLocal(receivedAt: string, timezone: string | undefined): string {
  const seconds = unixSeconds(receivedAt);
  if (seconds === null) return receivedAt.length > 0 ? receivedAt : 'an unknown time';
  // toLocalIso throws on an invalid zone. Callers pass the runtime's timezone,
  // which boot already validated. A missing zone formats as UTC.
  const local = toLocalIso(seconds, timezone);
  return local ?? receivedAt;
}

/**
 * The user message appended when a follow-up is drained. `exitDrain` is the
 * case where the model had already written a reply that was not sent.
 */
export function frameInjectedInput(
  input: FrameInjectedInput,
  options: { exitDrain: boolean; timezone?: string },
): Message {
  const label = input.senderLabel && input.senderLabel.length > 0 ? input.senderLabel : 'the sender';
  const channel = input.channelId.length > 0 ? input.channelId : 'unknown channel';
  const when = receivedLocal(input.receivedAt, options.timezone);
  const header =
    `[New message from ${label} via ${channel}, received ${when} — it arrived while you were working on this conversation and may change what you are doing.]`;
  const guidance = renderTurnGuidance(parseTurnGuidanceKeys(input.turnGuidance));
  const parts = [header];
  if (options.exitDrain) parts.push('Your reply draft above was **not** sent.');
  if (guidance) parts.push(guidance);
  parts.push(input.content);
  return { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] };
}
