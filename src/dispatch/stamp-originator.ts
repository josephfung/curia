// stamp-originator.ts — shared originator / liveTurn derivation for inbound work.
//
// The dispatcher and the voice session-create path both need the same security-critical
// mapping from a resolved (or unresolved) sender context to TaskOriginator + the
// live-principal-turn signal. Keeping that derivation in one pure helper means the
// elevated skill gate has a single source of truth (#1598 / #1126).

import type { InboundSenderContext, TaskOriginator } from '../contacts/types.js';

export interface StampOriginatorInput {
  /** Resolved/unresolved sender context from ContactResolver (or a console-built equivalent). */
  senderContext: InboundSenderContext | undefined | null;
  /** Channel the inbound arrived on (e.g. 'email', 'voice'). */
  channel: string;
  /**
   * Raw channel sender id. Used as the originator.contactId sentinel when the sender
   * could not be resolved — consistent with non-UUID values like 'system' / 'primary-user'.
   */
  senderId: string;
  /** Optional fixed timestamp for tests; defaults to now. */
  initiatedAt?: string;
}

export interface StampOriginatorResult {
  originator: TaskOriginator;
  /**
   * Live-principal-turn signal (#1126). True iff the originator resolved to the principal.
   * Sole satisfier of the `elevated` skill gate when paired with principal lineage.
   */
  liveTurn: boolean;
}

/**
 * Stamp TaskOriginator + the live-principal-turn signal from a sender context.
 *
 * Defence in depth (#1059): when the sender could not be resolved, still stamp an
 * originator with tier='unknown' so Gate C enforces tier policy instead of fail-open
 * skipping a missing originator.
 */
export function stampOriginator(input: StampOriginatorInput): StampOriginatorResult {
  const initiatedAt = input.initiatedAt ?? new Date().toISOString();
  const originator: TaskOriginator = input.senderContext?.resolved
    ? {
        contactId: input.senderContext.contactId,
        systemRole: input.senderContext.systemRole ?? null,
        channel: input.channel,
        initiatedAt,
        tier: input.senderContext.tier,
      }
    : {
        contactId: input.senderId,
        systemRole: null,
        channel: input.channel,
        initiatedAt,
        tier: 'unknown',
      };

  // The LIVE PRINCIPAL TURN signal (#1126) is `true` iff this inbound resolved to the principal.
  // It is the sole satisfier of the `elevated` skill gate. Callers stamp it as a DISTINCT field
  // on the agent.task payload (dispatcher) or session caller context (voice) — never inside a
  // metadata bag that could be persisted into wakeable state.
  const liveTurn = originator.systemRole === 'principal';
  return { originator, liveTurn };
}
