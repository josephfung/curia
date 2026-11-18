// The Nylas API key for the principal-inbox tools (#2409).
//
// One Nylas application serves both Curia's mailbox and the principal's, so the key is the
// same one the email channel uses: `channel.email.nylas_api_key`, as the console saves it.
// The flat `nylas_api_key` older installs seeded is renamed to it by migration (#2522).
//
// Every tool that calls this must declare the name in its manifest's `secrets`.

import type { ToolContext } from '../../src/skills/types.js';

export const CHANNEL_NYLAS_API_KEY = 'channel.email.nylas_api_key';

/** Throws when the key is not set or blank, with the same message ctx.secret() uses. */
export function ceoNylasApiKey(ctx: ToolContext): string {
  const key = ctx.secret(CHANNEL_NYLAS_API_KEY).trim();
  if (!key) throw new Error(`Secret '${CHANNEL_NYLAS_API_KEY}' is declared but not set in the environment`);
  return key;
}
