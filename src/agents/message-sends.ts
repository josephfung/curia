// message-sends.ts — which successful tool calls put a message in someone's inbox (#2055).
//
// The runtime records these on `agent.response` as `sends`. The delegate skill hands them
// to the coordinator as `sent`, so a specialist that only composed an email (and wrote
// "Email sent to Jamie" about it) cannot pass that text off as a delivery.
//
// Calendar writes count when the provider emails the guests. A hold never does. Errs
// toward counting: an update or delete on an event with no guests notifies nobody, but
// the input alone cannot tell. A calendar entry never vouches for an email or message:
// shapeSpecialistAnswer (src/agents/specialist-answer.ts) checks for those by name.

import { isHumanReplySkill } from '../dispatch/origin-turn-reply.js';

/**
 * True for a send that delivers an email or message. A send from the principal's mailbox (#2474)
 * counts, but stays out of the human-reply skills: those are refused on a delegated turn whose
 * originating turn owns the reply, and this tool is normally reached by delegation.
 */
export function isEmailOrMessageSend(toolName: string): boolean {
  return isHumanReplySkill(toolName) || toolName === 'ceo-inbox-send-draft';
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function hasGuests(record: Record<string, unknown>): boolean {
  const attendees = record['attendees'];
  return Array.isArray(attendees) && attendees.length > 0;
}

/** True when a successful call to `toolName` with `input` sent a message or calendar notification. */
export function isMessageSend(toolName: string, input: unknown): boolean {
  if (isEmailOrMessageSend(toolName)) return true;
  const record = inputRecord(input);
  // Google and EWS honour notifyAttendees=false; Microsoft rejects it (the call fails); iCloud
  // notifies anyway, which this undercounts. The skill's own warnings say so to the specialist.
  const notifies = record['notifyAttendees'] !== false;
  switch (toolName) {
    case 'calendar-create-event':
      return hasGuests(record);
    case 'calendar-update-event':
      // A recurrence change moves every occurrence, so guests get an update like a time change.
      return notifies && (
        hasGuests(record) || record['start'] !== undefined || record['end'] !== undefined || record['recurrence'] !== undefined
      );
    case 'calendar-delete-event':
      return notifies;
    case 'calendar-respond-to-invite':
      return true;
    default:
      return false;
  }
}
