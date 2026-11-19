// src/contacts/stamp-originator.ts — shared originator / liveTurn derivation for inbound work.
//
// The dispatcher and the voice session-create path both need the same security-critical
// mapping from a resolved (or unresolved) sender context to TaskOriginator + the
// live-principal-turn signal. Keeping that derivation in one pure helper means the
// elevated skill gate has a single source of truth (#1598 / #1126). Lives next to
// isLivePrincipalTurn (principal.ts) — both are contacts-domain predicates over
// SenderContext / TaskOriginator (#1628).

import type { InboundSenderContext, TaskOriginator } from './types.js';

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
  /**
   * The originating message authenticated its sender (#2312) — the caller computes it from the
   * channel and its adapter metadata (inboundSenderAuthenticated), or per voice transport
   * (voice/caller-context.ts). Required so no caller can forget it: it decides whether a
   * principal match carries the principal's authority (GHSA-p49r-jqh2-v668).
   */
  authenticated: boolean;
  /** Optional fixed timestamp for tests; defaults to now. */
  initiatedAt?: string;
}

export interface StampOriginatorResult {
  originator: TaskOriginator;
  /**
   * Live-principal-turn signal (#1126). True iff the originator resolved to the principal AND the
   * inbound authenticated them (GHSA-p49r-jqh2-v668). Sole satisfier of the `elevated` skill gate
   * when paired with principal lineage.
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
        authenticated: input.authenticated,
      }
    : {
        contactId: input.senderId,
        systemRole: null,
        channel: input.channel,
        initiatedAt,
        tier: 'unknown',
        // Authentication is about the message, not the contact: an unknown sender on Signal
        // is still that Signal account. Tier keeps it from authorizing anything.
        authenticated: input.authenticated,
      };

  // The LIVE PRINCIPAL TURN signal (#1126) is `true` iff this inbound resolved to the principal
  // and its channel authenticated the sender. A forged email From or a spoofed SMS number resolves
  // to the principal too: it keeps the identity (systemRole) but gets no live turn and, through
  // hasPrincipalAuthority, no principal authority (GHSA-p49r-jqh2-v668). It is the sole satisfier
  // of the `elevated` skill gate. Callers stamp it as a DISTINCT field on the agent.task payload
  // (dispatcher) or session caller context (voice) — never inside a metadata bag that could be
  // persisted into wakeable state.
  const liveTurn = originator.systemRole === 'principal' && input.authenticated;
  return { originator, liveTurn };
}
