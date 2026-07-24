// linkable-channels.ts — single allowlist for channel identities that may be
// linked via the console HTTP API or the contact-link-identity skill (#1514).
//
// Keep this file free of other src/ imports so the console can import it via a
// path alias without pulling the backend graph into the Vite bundle.

/** Channels operators / agents may bind onto a contact. */
export const LINKABLE_CHANNEL_IDENTITIES = [
  'email',
  'phone',
  'signal',
  'telegram',
  'slack',
  /** Telnyx SMS transport identity (E.164). Distinct from CRM `phone`. */
  'sms',
] as const;

export type LinkableChannelIdentity = (typeof LINKABLE_CHANNEL_IDENTITIES)[number];

/** Set form for O(1) membership checks in HTTP / skill validation. */
export const LINKABLE_CHANNEL_IDENTITY_SET: ReadonlySet<string> = new Set(
  LINKABLE_CHANNEL_IDENTITIES,
);
