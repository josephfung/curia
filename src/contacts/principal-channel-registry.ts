// principal-channel-registry.ts — single auditable list of channel contributions
// for principal-identity matching, outbound recipient projection, and Gate C
// carve-out opt-in.
//
// AUDIT POINT: a skill receives the Gate C principal carve-out ONLY if it appears
// as `carveoutSkill.skillName` or in `carveoutSkills` on an entry below. Channels
// without a carve-out still get identity matching + recipient projection for the
// outbound gateway, but fail closed for Gate C. Unknown / unregistered channels
// and skills also fail closed (empty projection ⇒ no principal carve-out in the
// gateway).
//
// Adding a channel: export `*PrincipalRules` (with `extractRecipients`) from the
// channel package and append exactly one entry here. Do not add per-channel
// branches to principal-recipient.ts or outbound-gateway recipient projection.

import type {
  CarveoutSkillSpec,
  PrincipalChannelRules,
} from './principal-channel-rules.js';
import { emailPrincipalRules } from '../channels/email/principal-rules.js';
import { signalPrincipalRules } from '../channels/signal/principal-rules.js';
import { slackPrincipalRules } from '../channels/slack/principal-rules.js';
import { smsPrincipalRules } from '../channels/sms/principal-rules.js';

/** Flatten `carveoutSkill` + `carveoutSkills` on one contribution. */
export function listCarveoutSkills(
  rules: PrincipalChannelRules,
): readonly CarveoutSkillSpec[] {
  return [
    ...(rules.carveoutSkill ? [rules.carveoutSkill] : []),
    ...(rules.carveoutSkills ?? []),
  ];
}

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
    for (const carveout of listCarveoutSkills(entry)) {
      if (skills.has(carveout.skillName)) {
        throw new Error(
          `principal-channel-registry: duplicate carveout skill '${carveout.skillName}'`,
        );
      }
      skills.add(carveout.skillName);
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
    listCarveoutSkills(rules).map((carveout) => carveout.skillName),
  ),
);

export function findPrincipalChannelRules(
  channel: string,
): PrincipalChannelRules | undefined {
  return PRINCIPAL_CHANNEL_RULES.find((rules) => rules.channel === channel);
}

export function findCarveoutSkill(
  skillName: string,
): { rules: PrincipalChannelRules; carveout: CarveoutSkillSpec } | undefined {
  for (const rules of PRINCIPAL_CHANNEL_RULES) {
    const carveout = listCarveoutSkills(rules).find((s) => s.skillName === skillName);
    if (carveout) return { rules, carveout };
  }
  return undefined;
}

export function findCarveoutRulesBySkill(
  skillName: string,
): PrincipalChannelRules | undefined {
  return findCarveoutSkill(skillName)?.rules;
}
