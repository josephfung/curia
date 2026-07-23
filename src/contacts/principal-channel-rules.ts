// principal-channel-rules.ts — per-channel contribution contract for principal
// identity matching and Gate C carve-out opt-in.
//
// Channels own comparator + send-skill recipient parsing; the central registry
// (principal-channel-registry.ts) is the single auditable list of contributions.
// Default is fail-closed: omit `carveoutSkill` and the skill gets no carve-out.

/**
 * Channel contribution for principal-identity checks and optional Gate C carve-out.
 *
 * - `identifiersEqual` — how this channel compares a candidate identifier to a
 *   stored verified identity (email folds case; Signal/Slack are exact).
 * - `carveoutSkill` — explicit opt-in. Absent ⇒ fail closed for Gate C (Slack
 *   today: comparator exists for the outbound gateway, but no send-skill carve-out).
 */
export interface PrincipalChannelRules {
  /** Stable channel id: 'email' | 'signal' | 'slack' | … */
  readonly channel: string;
  /** True when `a` and `b` refer to the same identity on this channel. */
  identifiersEqual(a: string, b: string): boolean;
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
