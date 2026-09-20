// principal-recipient.ts — structural principal recipient checks.
//
// Determines whether an outbound recipient matches the principal's verified channel
// identities. Used by the outbound content filter, outbound gateway, and Gate C
// (issue #1301). Never uses display name, role, or unverified identifiers.
//
// Channel-specific compare/parse/carve-out opt-in lives on each channel's
// `principal-rules.ts` and is listed in `principal-channel-registry.ts` (the
// single auditable Gate C opt-in surface). This file stays channel-agnostic.

import type { ChannelIdentity } from './types.js';
import {
  GATE_C_PRINCIPAL_CARVEOUT_SKILLS,
  findCarveoutSkill,
  findPrincipalChannelRules,
} from './principal-channel-registry.js';

export { GATE_C_PRINCIPAL_CARVEOUT_SKILLS };

export interface TaggedRecipient {
  identifier: string;
  isPrincipal: boolean;
}

/**
 * Whether `identifier` matches a verified principal identity on `channel`.
 * Comparison rules come from the channel's registered contribution; unknown
 * channels fail closed (false).
 */
export function isPrincipalIdentity(
  channel: string,
  identifier: string | undefined | null,
  principalIdentities: readonly ChannelIdentity[],
): boolean {
  if (!identifier || principalIdentities.length === 0) return false;
  const rules = findPrincipalChannelRules(channel);
  if (!rules) return false;
  return principalIdentities.some(
    (id) => id.channel === channel && rules.identifiersEqual(id.channelIdentifier, identifier),
  );
}

/**
 * After deduplicating by case-insensitive identifier, true only when exactly one
 * recipient remains and it is the principal.
 */
export function computePrincipalIsSoleRecipient(recipients: readonly TaggedRecipient[]): boolean {
  const seen = new Set<string>();
  const deduped: TaggedRecipient[] = [];
  for (const r of recipients) {
    const key = r.identifier.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped.length === 1 && deduped[0]!.isPrincipal;
}

/**
 * After deduplicating by `identifiersEqual`, true only when every remaining
 * recipient matches one of `initiatingIdentifiers`. Empty sets fail closed.
 */
export function isSolelyInitiatingSender(
  recipients: readonly string[],
  initiatingIdentifiers: readonly string[],
  identifiersEqual: (a: string, b: string) => boolean,
): boolean {
  if (recipients.length === 0 || initiatingIdentifiers.length === 0) return false;

  const unique: string[] = [];
  for (const recipient of recipients) {
    if (!unique.some((existing) => identifiersEqual(existing, recipient))) {
      unique.push(recipient);
    }
  }
  return unique.every((recipient) =>
    initiatingIdentifiers.some((id) => identifiersEqual(recipient, id)),
  );
}

/**
 * Resolve whether a skill invocation's recipient set is exclusively the principal,
 * using verified channel identities. Returns false when recipients cannot be
 * determined from the input (e.g. email-reply without a prior resolve) or when the
 * skill/input shape is not fully understood (fail closed).
 *
 * When `resolvedRecipients` is passed (including `null` for a failed resolve), that
 * list is used instead of `parseRecipients`. `null` fails closed.
 *
 * Fail-closed: only skills listed via `carveoutSkill` / `carveoutSkills` on a
 * registered channel contribution (see `GATE_C_PRINCIPAL_CARVEOUT_SKILLS`) can
 * receive the carve-out.
 */
export function resolvePrincipalIsSoleRecipientFromSkillInput(
  toolName: string,
  input: Record<string, unknown>,
  principalIdentities: readonly ChannelIdentity[],
  resolvedRecipients?: readonly string[] | null,
): boolean {
  if (principalIdentities.length === 0) return false;
  // Explicit allowlist check keeps the fail-closed default auditable in one Set.
  if (!GATE_C_PRINCIPAL_CARVEOUT_SKILLS.has(toolName)) return false;

  const found = findCarveoutSkill(toolName);
  if (!found) return false;

  const recipients = resolvedRecipients !== undefined
    ? resolvedRecipients
    : found.carveout.parseRecipients(input);
  if (recipients === null) return false;

  const tagged = recipients.map((identifier) => ({
    identifier,
    isPrincipal: isPrincipalIdentity(found.rules.channel, identifier, principalIdentities),
  }));
  return computePrincipalIsSoleRecipient(tagged);
}
