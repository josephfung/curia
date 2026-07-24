// principal-channel-registry.ts — single auditable list of channel contributions
// for principal-identity matching, outbound recipient projection, and Gate C
// carve-out opt-in.
//
// AUDIT POINT: a skill receives the Gate C principal carve-out ONLY if it appears
// as `carveoutSkill.skillName` on an entry below. Channels without a
// `carveoutSkill` still get identity matching + recipient projection for the
// outbound gateway, but fail closed for Gate C. Unknown / unregistered channels
// and skills also fail closed (empty projection ⇒ no principal carve-out in the
// gateway).
//
// Adding a channel: export `*PrincipalRules` (with `extractRecipients`) from the
// channel package and append exactly one entry here. Do not add per-channel
// branches to principal-recipient.ts or outbound-gateway recipient projection.

import type { PrincipalChannelRules } from './principal-channel-rules.js';
import { emailPrincipalRules } from '../channels/email/principal-rules.js';
import { signalPrincipalRules } from '../channels/signal/principal-rules.js';
import { slackPrincipalRules } from '../channels/slack/principal-rules.js';
import { smsPrincipalRules } from '../channels/sms/principal-rules.js';

/**
 * Fail fast on duplicate channel ids or carve-out skill names. First-match
 * `.find` lookups would otherwise silently shadow a second entry.
 */
export function assertPrincipalChannelRegistryUnique(
  rules: readonly PrincipalChannelRules[],
): void {
  const channels = new Set<string>();
  const skills = new Set<string>();
  for (const entry of rules) {
    if (channels.has(entry.channel)) {
      throw new Error(
        `principal-channel-registry: duplicate channel '${entry.channel}'`,
      );
    }
    channels.add(entry.channel);
    const skillName = entry.carveoutSkill?.skillName;
    if (skillName !== undefined) {
      if (skills.has(skillName)) {
        throw new Error(
          `principal-channel-registry: duplicate carveout skill '${skillName}'`,
        );
      }
      skills.add(skillName);
    }
  }
}

/** Ordered registry of channel principal rules. This is the Gate C opt-in list. */
export const PRINCIPAL_CHANNEL_RULES: readonly PrincipalChannelRules[] = [
  emailPrincipalRules,
  signalPrincipalRules,
  slackPrincipalRules,
  smsPrincipalRules,
];

assertPrincipalChannelRegistryUnique(PRINCIPAL_CHANNEL_RULES);

/** Derived allowlist of skill names opted into the Gate C principal carve-out. */
export const GATE_C_PRINCIPAL_CARVEOUT_SKILLS: ReadonlySet<string> = new Set(
  PRINCIPAL_CHANNEL_RULES.flatMap((rules) =>
    rules.carveoutSkill ? [rules.carveoutSkill.skillName] : [],
  ),
);

export function findPrincipalChannelRules(
  channel: string,
): PrincipalChannelRules | undefined {
  return PRINCIPAL_CHANNEL_RULES.find((rules) => rules.channel === channel);
}

export function findCarveoutRulesBySkill(
  skillName: string,
): PrincipalChannelRules | undefined {
  return PRINCIPAL_CHANNEL_RULES.find(
    (rules) => rules.carveoutSkill?.skillName === skillName,
  );
}
