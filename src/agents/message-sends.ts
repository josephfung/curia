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
  if (isHumanReplySkill(toolName)) return true;
  const record = inputRecord(input);
  // Google honours notifyAttendees=false; Microsoft and iCloud notify anyway, which this
  // undercounts. The skill's own warnings say so to the specialist.
  const notifies = record['notifyAttendees'] !== false;
  switch (toolName) {
    case 'calendar-create-event':
      return hasGuests(record);
    case 'calendar-update-event':
      return notifies && (hasGuests(record) || record['start'] !== undefined || record['end'] !== undefined);
    case 'calendar-delete-event':
      return notifies;
    case 'calendar-respond-to-invite':
      return true;
    default:
      return false;
  }
}
