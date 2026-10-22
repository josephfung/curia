// voice-tools.ts — the tool list a spoken turn is given (#1968).
//
// Voice used to inherit the coordinator's whole pin set plus the discovery tools:
// 73 local tool definitions (~20k tokens) on every spoken round, almost all of
// them unusable inside the 8-round streaming cap. This list is voice's own.
//
// Derived from production voice sessions (19 calls, 2026-07-26 → 2026-10-15). Those
// calls asked for: the calendar (5 delegations), the principal's inbox, research,
// social-media drafts, an async off-ramp, and reading and updating the to-do list.
// One call asked to remember a fact. Everything a specialist owns is reached
// through `delegate`, so the specialists' own tools stay off this list.
//
// Deliberately absent:
//   - `tool-registry` / `skill-activate`: the voice turn's tool list is fixed for the
//     turn, so a tool activated mid-call never becomes callable. Discovery only
//     costs rounds. Work that needs it goes through `async-offramp`.
//   - sends, email, scheduler, documents, autonomy approvals: never asked for on a
//     call. Hand them to the async coordinator with `async-offramp`, or delegate.
//
// Add a tool here only with evidence that a live call needs it and can finish with
// it inside the round cap. ADR-037 calls voice a curated subset of the coordinator;
// tests/unit/channels/voice/voice-tools.test.ts holds this list to that.
export const VOICE_TOOL_NAMES: readonly string[] = [
  // Specialist domains: calendar, contacts, inbox, research, social-media drafts.
  'delegate',
  // Calendar briefs must carry a date date-resolve produced this turn (#1612).
  'date-resolve',
  // Heavyweight asks leave the call (#1614). Voice-only: not a coordinator pin.
  'async-offramp',
  // The to-do list the principal reads and edits by voice.
  'task-list',
  'task-create',
  'task-update',
  'task-complete',
  // "Remember that…" / "what do you know about…".
  'memory-query',
  'memory-store',
];
