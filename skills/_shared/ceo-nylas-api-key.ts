// The Nylas API key for the principal-inbox tools (#2409).
//
// One Nylas application serves both Curia's mailbox and the principal's, so the key is the
// same one the email channel uses. The console saves it as `channel.email.nylas_api_key`;
// older installs seeded the flat `nylas_api_key`. Resolve in the channel's order — the
// console key first — so an install configured only through the console works.
//
// Every tool that calls this must declare both names in its manifest's `secrets`.

import type { ToolContext } from '../../src/skills/types.js';

export const CHANNEL_NYLAS_API_KEY = 'channel.email.nylas_api_key';
export const LEGACY_NYLAS_API_KEY = 'nylas_api_key';

// The execution layer's message for a declared secret that resolves nowhere. Only that
// case falls through to the legacy key; any other error (an undeclared name, a vault
// failure) propagates.
const SECRET_ABSENT_MSG = 'is declared but not set in the environment';

/** Throws when neither key is set, with the same message ctx.secret() uses. */
export function ceoNylasApiKey(ctx: ToolContext): string {
  try {
    const key = ctx.secret(CHANNEL_NYLAS_API_KEY).trim();
    if (key) return key;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(SECRET_ABSENT_MSG)) throw err;
  }
  return ctx.secret(LEGACY_NYLAS_API_KEY);
}
