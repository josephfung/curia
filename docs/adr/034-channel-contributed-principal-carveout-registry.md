# ADR-034: Channel-contributed principal carve-out registry

Date: 2026-07-23
Status: Accepted

## Context

Gate C's principal-only carve-out (#1301) needs two pieces of channel knowledge for
each outbound send skill: (1) how to compare a candidate identifier to a verified
principal identity on that channel, and (2) how to parse recipient-shaped skill
input. Those lived as hard-coded branches in `src/contacts/principal-recipient.ts`
(`isPrincipalEmail` / `isPrincipalSignal` / `isPrincipalSlack`, per-skill parsers,
and a central allowlist Set). Adding Slack (#1473) showed the cost: every new
channel touches the same security-critical file in several places.

Pushing the logic into each adapter alone would scatter the fail-closed boundary
and make audits harder — a reviewer could no longer confirm in one place that
unopted skills get no carve-out.

## Decision

Each channel exports a `PrincipalChannelRules` contribution (comparator + optional
`carveoutSkill` opt-in with a recipient parser). Contributions are listed in
`src/contacts/principal-channel-registry.ts` — the single auditable Gate C opt-in
surface. `principal-recipient.ts` stays channel-agnostic: it looks up the registry
and fails closed when the skill/channel is absent or has no `carveoutSkill`.

Omit `carveoutSkill` to keep the conservative default (Slack today: identity
matching for the outbound gateway, no Gate C carve-out until a send skill opts in).

## Consequences

- Adding a channel means writing `channels/<name>/principal-rules.ts` and appending
  one registry entry — no new branches inside `principal-recipient.ts`.
- Reviewers audit Gate C opt-in by reading the registry (and the derived
  `GATE_C_PRINCIPAL_CARVEOUT_SKILLS` Set), not by grepping adapters.
- Call sites use `isPrincipalIdentity(channel, …)` instead of per-channel helpers.
- Trade-off: the registry still imports each channel module explicitly (no
  side-effect self-registration), by design — an invisible register call would
  weaken the audit story.
- The outbound gateway still owns request-shape → recipient projection
  (`projectRecipients`) in one place until channels fully own that wire-shape
  (#1513). Identity compare and Gate C skill parsing do not live there.
