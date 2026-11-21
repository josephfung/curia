// triage-hold.ts — the onboarding triage hold (#2360).
//
// While held, the inbox heartbeat does not wake scheduled triage, so Curia does not start
// labelling a mailbox the principal has not yet been told about. The hold gates the heartbeat
// only; principal-directed mailbox actions are unaffected. A missing key means no hold, so
// existing installs keep triaging.

import type { ConfigStore } from '../memory/config-store.js';
import type { Logger } from '../logger.js';
import { ONBOARDING_NAMESPACE } from './state.js';

export const TRIAGE_HOLD_KEY = 'triage_hold';

/**
 * Whether triage is held. Missing → false; `{"held":true}` → true; malformed → true and warn
 * (fail closed: an unreadable hold must not start labelling a mailbox nobody was told about).
 * Infrastructure errors from the store propagate.
 */
export async function isTriageHeld(store: Pick<ConfigStore, 'get'>, logger?: Logger): Promise<boolean> {
  const raw = await store.get(ONBOARDING_NAMESPACE, TRIAGE_HOLD_KEY);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const held = (parsed as Record<string, unknown>).held;
      if (typeof held === 'boolean') return held;
    }
    throw new Error('triage hold has an unexpected shape');
  } catch (err) {
    logger?.warn({ err }, 'onboarding: triage hold is malformed, treating as held');
    return true;
  }
}

/** Write the hold. Throws when the store soft-rejects the write ({stored:false}): never fail open. */
export async function writeTriageHold(store: Pick<ConfigStore, 'set'>, held: boolean): Promise<void> {
  const { stored } = await store.set(ONBOARDING_NAMESPACE, TRIAGE_HOLD_KEY, JSON.stringify({ held }));
  if (!stored) throw new Error(`onboarding: the config store rejected the triage hold write (held: ${held})`);
}

/** Hold triage. */
export function setTriageHold(store: Pick<ConfigStore, 'set'>): Promise<void> {
  return writeTriageHold(store, true);
}

/** Release the hold; triage resumes on the next heartbeat tick. */
export function releaseTriageHold(store: Pick<ConfigStore, 'set'>): Promise<void> {
  return writeTriageHold(store, false);
}
