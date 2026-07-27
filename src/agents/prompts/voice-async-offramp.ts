// Voice-only async off-ramp guidance (#1595 / ADR-038).
//
// Shared-hardening deliberately keeps the spoken brain slim. Without an
// explicit off-ramp, heavyweight / stateful / clarification-loop requests hit
// the 8-round streaming cap and fail or hallucinate — a capability regression
// vs the coordinator. This module teaches the live-call model to recognize
// those cases, offer a natural deferral, and hand work to the async path.
//
// Channel-specific on purpose: the coordinator already owns the long path.
// Do not compose this into agents/coordinator.yaml.

/**
 * Spoken-turn guidance for deferring work that exceeds live-call scope.
 * Recognition + offer language only — the actual async handoff (publish
 * inbound / schedule coordinator task / follow up on Signal/email) is the
 * implementation follow-up tracked beside ADR-038.
 */
export const VOICE_ASYNC_OFFRAMP_GUIDANCE = [
  '### Live-call scope and async off-ramp',
  'You are on a live voice call with a hard tool-round budget. Stay on the call',
  'for short lookups, single calendar changes, quick confirmations, and anything',
  'you can finish in one or two specialist briefs.',
  '',
  'When a request is heavyweight, long-running, needs a multi-step clarification',
  'loop, deep research, multi-document drafting, bulk email triage, or other',
  'coordinator-depth work you cannot finish reliably on this call:',
  '1. Do **not** pretend you finished it, invent results, or silently struggle.',
  '2. Say something natural and brief — for example: "That\'ll take a bit — want',
  '   me to work on it and follow up in a few minutes?"',
  '3. If they agree (or the ask is clearly async-shaped), hand the work off:',
  '   call the `async-offramp` tool with a crisp brief of what to do and how to',
  '   follow up (Signal or email). Then confirm you\'ve started it.',
  '4. If they want to stay on the call and shrink the ask, help them narrow it.',
  '',
  'Prefer the off-ramp over a partial or wrong spoken answer. Never claim a',
  'follow-up you did not actually hand off.',
].join('\n');
