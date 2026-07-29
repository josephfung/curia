/** Synthetic user message that triggers the opening turn. */
export const VOICE_GREETING_USER_MESSAGE =
  '[Call connected — open the conversation.]';

/**
 * Opening-turn instruction for inbound console calls (#1596). Appended to the
 * spoken-turn system prompt so Curia greets first; lean on outbound-context and
 * the time block when present. Not used for Curia-initiated outbound calls.
 */
export const VOICE_GREETING_INSTRUCTION =
  'The principal just called and joined the line. Open the conversation naturally ' +
  'and briefly — a short spoken greeting appropriate to the time of day. If active ' +
  'outbound context is present, acknowledge it in one breath. Do not wait for them ' +
  'to speak first. One or two short sentences only.';

/** True when content is the synthetic voice opening cue (hide from console history). */
export function isVoiceGreetingCueContent(content: string): boolean {
  return content === VOICE_GREETING_USER_MESSAGE;
}
