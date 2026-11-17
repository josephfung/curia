// hold-recipient-name.ts — the recipient name a held send's approval shows (signal/sms/slack-send).
//
// A hold's description names the contact so the agent can match the principal's answer ("share it
// with Dana") to the approval (scenario 34k). A contact's display name can come from an outsider
// (an email From name), and the description reaches the approval card and the wake brief, so it
// goes through the same display-name sanitizer the contact store uses, then a short cap: a name,
// not a paragraph. Fallbacks: the identity label, then the raw destination.

import { sanitizeDisplayName } from '../sanitize.js';

/** Longest name a hold description carries; anything longer is not a name. */
export const HOLD_RECIPIENT_NAME_MAX = 60;

export function holdRecipientName(displayName: string | undefined, identityName: string | undefined, destination: string): string {
  const fallback = identityName?.trim() || destination;
  return sanitizeDisplayName(displayName?.trim() || fallback, fallback).slice(0, HOLD_RECIPIENT_NAME_MAX).trim();
}
