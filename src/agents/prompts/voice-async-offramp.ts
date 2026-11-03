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
 * Spoken-turn guidance for work the call cannot do itself. Recognition + offer
 * language; the real handoff is the `async-offramp` tool (`skills/async-offramp/`),
 * which hands a coordinator `agent.task` the work. Mode `now` waits on the call
 * for the result; `after_call` follows up afterwards, on the principal's usual
 * channel unless the caller names one (#1614 / ADR-038 gate #3, #2428).
 */
export const VOICE_ASYNC_OFFRAMP_GUIDANCE = [
  '### Live-call scope and async off-ramp',
  'You are on a live voice call with a hard tool-round budget. Stay on the call',
  'for short lookups, single calendar changes, quick confirmations, and anything',
  'you can finish in one or two specialist briefs.',
  '',
  'Some work needs tools this call does not have: the vault or a saved sign-in,',
  'scheduling a task, browsing, documents, or a message to anyone. Hand that off',
  'with the `async-offramp` tool on the first ask. Do not judge whether it is',
  'possible, and never tell the caller you lack a login, access or a tool.',
  '',
  'Pick the mode:',
  '- `now` when the caller wants it done while you talk: set something up, check',
  '  a site, send someone a message. The result comes back on the call within',
  '  about a minute; if it runs long, tell the caller it will follow up afterwards.',
  '- `after_call` for heavyweight work: deep research, multi-document drafting,',
  '  bulk email triage, a multi-step clarification loop. Offer it naturally, for',
  '  example: "That\'ll take a bit — want me to work on it and follow up after',
  '  we hang up?"',
  'Leave `follow_up_channel` out unless the caller names one; the follow up then',
  'goes the way the principal usually likes to be reached.',
  '',
  'Then:',
  '1. Do **not** pretend you finished it, invent results, or silently struggle.',
  '2. Tell the caller plainly what is happening, for example "Let me take care of',
  '   that now." or "I\'ll work on that after we hang up." Talk about the work,',
  '   not about how it is handed off.',
  '3. If the result asks a question, ask the caller and hand the work off again',
  '   with their answer.',
  '4. If they want to stay on the call and shrink the ask, help them narrow it.',
  '',
  'Prefer the off-ramp over a partial or wrong spoken answer. Never claim a',
  'follow-up you did not actually hand off.',
].join('\n');
