// principal-channel-rules.ts — per-channel contribution contract for principal
// identity matching, Gate C carve-out opt-in, and outbound recipient projection.
//
// Channels own comparator + send-skill recipient parsing + request→identifier
// projection; the central registry (principal-channel-registry.ts) is the single
// auditable list of contributions. Default is fail-closed: omit `carveoutSkill`
// and the skill gets no carve-out; return null from `extractRecipients` and the
// gateway treats the request as having no principal-eligible recipients.

/**
 * One projected recipient identifier from an outbound send request, plus whether
 * that identifier may ever match the principal (group/conversation ids are false).
 */
export interface ProjectedRecipient {
  identifier: string;
  principalEligible: boolean;
}

/**
 * Channel contribution for principal-identity checks, outbound recipient
 * projection, and optional Gate C carve-out.
 *
 * - `identifiersEqual` — how this channel compares a candidate identifier to a
 *   stored verified identity (email folds case; Signal/Slack are exact).
 * - `extractRecipients` — maps this channel's outbound request wire-shape onto
 *   recipient identifiers for principal tagging. Returns null when the request
 *   is not this channel's shape (fail closed).
 * - `carveoutSkill` — explicit opt-in. Absent ⇒ fail closed for Gate C
 *   (comparator + projector may still exist for the outbound gateway without a
 *   send-skill carve-out).
 */
export interface PrincipalChannelRules {
  /** Stable channel id: 'email' | 'signal' | 'slack' | … */
  readonly channel: string;
  /** True when `a` and `b` refer to the same identity on this channel. */
  identifiersEqual(a: string, b: string): boolean;
  /**
   * Project an outbound send request onto recipient identifiers.
   * Returns null when `request` is not this channel's wire shape (fail closed —
   * the gateway yields an empty recipient set / no principal carve-out).
   */
  extractRecipients(request: unknown): ProjectedRecipient[] | null;
  /**
   * When set, `skillName` is opted into Gate C's principal-only carve-out and
   * `parseRecipients` fully models that skill's recipient-shaped input.
   * Returns null when the input contains unmodeled recipient keys (fail closed).
   */
  readonly carveoutSkill?: {
    readonly skillName: string;
    parseRecipients(input: Record<string, unknown>): string[] | null;
  };
}
