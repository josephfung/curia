// build-principal-sender-context.ts — sole constructor for principal SenderContext.
//
// ContactResolver (cli/web/smoke-test) and the voice console path both need the same
// principal identity shape: either the real principal contact row, or the synthetic
// `primary-user` fallback used before seeding / on a DB blip. Keeping both branches
// here means the migration-055 `kind !== 'principal'` warning cannot drift out of
// the voice path (#1627 / #1598 review item 4).

import type { Logger } from '../logger.js';
import type { ContactKind, SenderContext, SystemRole } from './types.js';

/** Fields needed to construct a principal SenderContext from a contact row. */
export interface PrincipalSenderInput {
  id: string;
  displayName: string;
  role: string | null;
  systemRole: SystemRole | null;
  kgNodeId: string | null;
  /**
   * Stored kind — authoritative only for the migration-055 warning below.
   * Output always forces `kind: 'principal'`.
   */
  kind: ContactKind;
}

/**
 * Build a SenderContext for the principal contact (or the synthetic CLI/web fallback).
 *
 * Forces `systemRole` / `tier` / `kind` to `'principal'` unconditionally — a stale
 * stored value is observable via the warning (tagged with `source` so operators can
 * tell which caller hit it), never surfaced to callers. The synthetic fallback always
 * stamps the same three axes.
 *
 * @param source — short caller tag (e.g. `'contact-resolver'`, `'voice-console'`)
 *   included in warning structured fields for operator triage.
 */
export function buildPrincipalSenderContext(
  principal: PrincipalSenderInput | null,
  logger: Logger,
  source: string,
): SenderContext {
  if (principal) {
    // Warn if migration-055 backfill missed this principal row — kind should
    // always be 'principal' for a system_role='principal' contact. The ?? fallback
    // can't catch this because the kind column is NOT NULL (backfill leaves 'person',
    // not NULL). Making it unconditional here is both authoritative and observable.
    if (principal.kind !== 'principal') {
      logger.warn(
        { source, contactId: principal.id, kind: principal.kind },
        'principal contact has kind != "principal" — migration-055 backfill may have missed this row',
      );
    }
    // Same treatment for systemRole: a "principal" context whose systemRole is null
    // would disagree with itself (liveTurn reads systemRole; tier/kind read as
    // privileged elsewhere). Force + warn, matching kind (#1627).
    if (principal.systemRole !== 'principal') {
      logger.warn(
        { source, contactId: principal.id, systemRole: principal.systemRole },
        'principal contact has systemRole != "principal"',
      );
    }
    return {
      resolved: true,
      contactId: principal.id,
      displayName: principal.displayName,
      role: principal.role,
      systemRole: 'principal',
      verified: true,
      kgNodeId: principal.kgNodeId,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 1.0, // principal always gets max confidence
      // Principal always gets the highest tier and is always kind='principal'.
      // Set unconditionally — the stored row value is authoritative only for the
      // warning check above; we never surface a non-principal kind for the CEO.
      tier: 'principal',
      kind: 'principal',
    };
  }

  // Fresh install / DB blip — synthetic ID. Skills that need a real UUID will
  // return empty results; best we can do until a principal contact exists.
  return {
    resolved: true,
    contactId: 'primary-user',
    displayName: 'CEO',
    role: 'ceo',
    systemRole: 'principal',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1.0,
    tier: 'principal',
    kind: 'principal',
  };
}
