// A grant lookup that reads the Nylas API key and region live on every call (#2361, R7).
//
// The principal sign-in callback adds and re-grants mailboxes through PrincipalMailboxAdmin, whose
// lookupGrant used to close over the key read at boot. Sign-in readiness reads the key live, so a
// key saved in the console after boot made sign-in "ready" while every add was refused as
// grant_unreadable. This closure reads through the same readers readiness uses (vault, then env).
//
// With the boot values given, a key or region changed since boot throws NylasRestartRequiredError
// before Nylas is asked: the mailbox would be served with the boot values, so the admin refuses
// the add (or reconnect) until a restart, as sign-in readiness does (R11).

import { MissingNylasApiKeyError, NylasRestartRequiredError } from '../principal-mailboxes/types.js';
import { nylasApiUri, type NylasRegion } from './region.js';
import { nylasRestartRequired, type NylasBootConfig } from './signin-readiness.js';

export interface LiveGrantLookupDeps {
  readApiKey: () => Promise<string | undefined>;
  readRegion: () => Promise<NylasRegion>;
  /** The key and region the process booted with. Absent: no restart check (tests). */
  boot?: NylasBootConfig;
  /** Reads one grant with the given key and region base URL (a NylasClient in production). */
  lookup: (apiKey: string, apiUri: string, grantId: string) => Promise<{ email: string; provider: string }>;
}

export function createLiveGrantLookup(
  deps: LiveGrantLookupDeps,
): (grantId: string) => Promise<{ email: string; provider: string }> {
  return async (grantId) => {
    const apiKey = (await deps.readApiKey())?.trim();
    // Typed, and carries no key or grant id: the admin logs it with grantSafeErrorFields.
    if (!apiKey) throw new MissingNylasApiKeyError();
    const region = await deps.readRegion();
    if (deps.boot !== undefined && nylasRestartRequired(apiKey, region, deps.boot)) {
      throw new NylasRestartRequiredError();
    }
    return deps.lookup(apiKey, nylasApiUri(region), grantId);
  };
}
