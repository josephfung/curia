// tests/shared/recipient-guard.ts — production's recipient-reference boundary for stubbed sends (#2149).
//
// The send skills take a contact ID or "principal" in their reference fields, never a
// typed address (ADR-047). A success stub for a send stands in for the delivery, not for
// that check, which the skill runs first: without this, a stub answers a send production
// would refuse, and a case can pass on it. Shape only, like the skill's first step: a
// well-formed reference still goes to the stub, whether or not the contact exists.
//
// The message is production's own (recipientReferenceShapeError). Both the scenario and
// the smoke stub layers call this, the way scenarios call emailAttachmentRefusal.

import { recipientReferenceShapeError } from '../../src/skills/_shared/recipient-reference.js';

/**
 * Reference-only inputs per send skill. email-reply's `cc` is not here: it also takes
 * plain addresses (#2131). A field may hold a comma-separated list (email-send's `cc`,
 * and its `to`, which goes through the same list parser).
 */
const REFERENCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'email-send': ['to', 'cc'],
  'email-draft-save': ['to'],
  'signal-send': ['recipient'],
  'sms-send': ['recipient'],
  'slack-send': ['recipient'],
};

/**
 * The error production would return for a reference field holding something other than
 * a reference, or undefined when every entry is one (or the tool takes no references).
 * A missing or empty field is the handler's own error, which this does not reproduce.
 */
export function recipientReferenceRefusal(toolName: string, input: Record<string, unknown>): string | undefined {
  const fields = Object.hasOwn(REFERENCE_FIELDS, toolName) ? REFERENCE_FIELDS[toolName]! : [];
  for (const field of fields) {
    const raw = input[field];
    if (typeof raw !== 'string') continue;
    for (const entry of raw.split(',').map(e => e.trim()).filter(e => e !== '')) {
      const error = recipientReferenceShapeError(entry, { field });
      if (error !== null) return error;
    }
  }
  return undefined;
}
