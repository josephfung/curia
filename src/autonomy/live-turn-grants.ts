// src/autonomy/live-turn-grants.ts
//
// Live-turn grants for work the principal directs on a voice call (#2495, ADR-017 amendment).
//
// A voice call is a live principal turn, but the work it hands to the coordinator crosses
// an async boundary (async-offramp). #1126 keeps `liveTurn` off anything async so a woken,
// scheduled or derived task can never approve its own action. A grant is the narrow way
// through: a now hand-off carries `liveTurn` together with a grant id, and the live turn
// counts only while the grant is active. The off-ramp revokes it when its wait on the call
// returns, and the voice runtime revokes every grant for a session when the call ends.
// A hard TTL ends it anyway if neither revoke runs.
//
// Grants are process-local and in memory only. The id travels as a distinct top-level
// field on agent.task (never in `metadata`), so no skill that forwards the metadata bag can
// persist it, and after a restart every id reads as lapsed.
//
// An id that is not active means the principal directed this work on a call that is no
// longer live: the execution layer turns an elevated call under it into a confirmation
// request instead of a bare refusal. An after_call hand-off gets such an id from the start
// (lapsedLiveTurnGrantId).

import { randomUUID } from 'node:crypto';

interface GrantEntry {
  voiceSessionId: string | null;
  expiresAt: number;
}

// One registry per process, not per module instance. Skill handlers are loaded from their
// own files, so in the built image `skills/async-offramp` can import a different copy of this
// module than the bundled execution layer and voice runtime. A module-level Map would give
// each copy its own grants, and the execution layer would read every live grant as lapsed.
const REGISTRY_KEY = Symbol.for('curia.liveTurnGrants');
const registryHolder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, GrantEntry> };
const activeGrants: Map<string, GrantEntry> = (registryHolder[REGISTRY_KEY] ??= new Map<string, GrantEntry>());

/** A grant the off-ramp holds while the principal is still on the call. */
export interface LiveTurnGrant {
  readonly id: string;
  /** End the grant. Idempotent. */
  revoke(): void;
}

/**
 * Issue a grant bound to a voice session. It lapses after `ttlMs` even if never revoked.
 * `now` is injectable for tests.
 */
export function issueLiveTurnGrant(opts: {
  voiceSessionId?: string | null;
  ttlMs: number;
  now?: () => number;
}): LiveTurnGrant {
  const now = opts.now ?? Date.now;
  const id = `ltg-${randomUUID()}`;
  activeGrants.set(id, {
    voiceSessionId: opts.voiceSessionId ?? null,
    expiresAt: now() + Math.max(0, opts.ttlMs),
  });
  return {
    id,
    revoke: () => {
      activeGrants.delete(id);
    },
  };
}

/** A grant id that was never active: the principal directed the work, but not live. */
export function lapsedLiveTurnGrantId(): string {
  return `ltg-lapsed-${randomUUID()}`;
}

/** True while the grant is issued, unrevoked and unexpired. */
export function isLiveTurnGrantActive(id: string | undefined, now: () => number = Date.now): boolean {
  if (typeof id !== 'string') return false;
  const entry = activeGrants.get(id);
  if (!entry) return false;
  if (now() >= entry.expiresAt) {
    activeGrants.delete(id);
    return false;
  }
  return true;
}

/** End every grant bound to a voice session (the call ended). Returns how many ended. */
export function revokeLiveTurnGrantsForVoiceSession(voiceSessionId: string): number {
  let revoked = 0;
  for (const [id, entry] of activeGrants) {
    if (entry.voiceSessionId === voiceSessionId) {
      activeGrants.delete(id);
      revoked += 1;
    }
  }
  return revoked;
}

/** Exported for tests. */
export function activeLiveTurnGrantCountForTests(): number {
  return activeGrants.size;
}

/** Exported for tests. */
export function resetLiveTurnGrantsForTests(): void {
  activeGrants.clear();
}
