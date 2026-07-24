# ADR-035: Channel-owned outbound recipient projection

Date: 2026-07-24
Status: Accepted

## Context

ADR-034 moved principal identity comparison and Gate C skill-input parsing onto
per-channel `PrincipalChannelRules` contributions. It deliberately left one
concern in the outbound gateway: projecting an `OutboundSendRequest` onto the
recipient identifiers used for principal tagging (`projectRecipients`).

That projection encodes security-critical never-principal fields (Signal
`groupId`, Slack `slackChannelId` / D…/C… conversation ids). Keeping it in the
gateway meant every new channel still required a `switch (request.channel)` edit
in `src/skills/outbound-gateway.ts`.

The blocker in #1511 was layering: `OutboundSendRequest` lived in the skills/
gateway layer *above* `src/channels/`. A channel module could not own projection
over that type without inverting the dependency. Relocating the request variants
is a public-API-surface change and needed an ADR.

Alternatives considered:

1. **Keep projection in the gateway** (status quo after #1511) — one function to
   edit per channel, but not zero gateway edits.
2. **Put `extractRecipients` on the `Channel` adapter interface** — couples the
   lifecycle adapter (`start`/`stop`) to outbound wire shape and complicates
   conformance tests for always-on channels that do not send externally.
3. **Channel-owned request variants + `PrincipalChannelRules.extractRecipients`**
   (chosen) — matches ADR-034's contribution pattern; registry stays the
   auditable list; gateway delegates and fails closed when rules are absent.

## Decision

1. Move each `OutboundSendRequest` variant into its owning channel package
   (`src/channels/<name>/outbound-request.ts`). The gateway re-exports the
   discriminated union so existing import paths remain stable (public API).
2. Extend `PrincipalChannelRules` with
   `extractRecipients(request: unknown): ProjectedRecipient[] | null`. Each
   channel narrows its own request shape and marks identifiers as
   `principalEligible` (or not) — including the never-trust conversation/group
   id fail-safe.
3. `OutboundGateway.projectRecipients` becomes a thin registry lookup:
   `findPrincipalChannelRules(request.channel)?.extractRecipients(request) ?? []`.
   Unregistered channels and unrecognized shapes yield an empty list (no
   principal carve-out).

Delivery dispatch (`dispatchEmail` / `dispatchSignal` / `dispatchSlack`) stays
in the gateway — that is transport wiring, not principal tagging.

## Consequences

- Adding a channel for principal-recipient tagging requires
  `outbound-request.ts` + `extractRecipients` on `principal-rules.ts` and a
  registry append — **no** recipient-projection edit in
  `outbound-gateway.ts`.
- Reviewers still audit Gate C opt-in and identity matching via the registry
  (ADR-034); recipient projection is co-located with those contributions.
- Callers may import request types from the channel package or continue
  importing re-exports from `outbound-gateway.ts`.
- Trade-off: the gateway still branches on `request.channel` for *delivery*
  dispatch and a few body/subject field reads. Those are out of scope here;
  zero gateway edits for *recipient projection* is the acceptance bar (#1513).
- Completes the deferred consequence called out in ADR-034.
