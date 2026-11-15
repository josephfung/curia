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
  /** Set when the message was sent on another conversation and handed to this turn (#2588). */
  handedOverFrom?: { channelId: string; conversationLabel: string };
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

// Defence in depth: the lane already single-lines these, but a caller of the
// framer may not have gone through it.
function oneLine(value: string, max: number): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

// `channel` arrives already JSON-quoted.
function confirmationGuidance(channel: string): string {
  return [
    'Give them exactly one confirmation of the outcome.',
    `By default send it on ${channel}: for the principal use the send tool with recipient "principal"; for anyone else, use the send tool to their contact on ${channel}. Then end this conversation's turn with NO_REPLY.`,
    `If the outcome has a lot of detail, you may confirm here instead and not on ${channel}.`,
    'If that send is refused or needs approval, reply here instead.',
  ].join(' ');
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
  const handed = input.handedOverFrom;
  const header = handed
    ? `[Handed over from ${oneLine(label, 80)}'s ${oneLine(handed.channelId, 64) || 'unknown channel'} conversation (${JSON.stringify(oneLine(handed.conversationLabel, 60))}), received ${when}: they sent this there while you were working on this. It may change what you are doing.]`
    : `[New message from ${label} via ${channel}, received ${when} — it arrived while you were working on this conversation and may change what you are doing.]`;
  const guidance = renderTurnGuidance(parseTurnGuidanceKeys(input.turnGuidance));
  const parts = [header];
  if (handed) parts.push(confirmationGuidance(JSON.stringify(oneLine(handed.channelId, 64) || 'unknown channel')));
  if (options.exitDrain) parts.push('Your reply draft above was **not** sent.');
  if (guidance) parts.push(guidance);
  parts.push(input.content);
  return { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] };
}
