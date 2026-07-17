# Learning subsystem: machine state → config-store JSON — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the learning subsystem's queue/status/guard machine-state out of OKF markdown doc bodies into config-store JSON under the `ceo_inbox` namespace, deleting the regex-parse / block-rewrite machinery while keeping prose evidence (`pending-diffs.md`), snapshots, and shadow docs in OKF.

**Architecture:** Five new `ceo_inbox` config keys, each a single whole-rewritten JSON value accessed through a new `skills/_shared/learning-state.ts` module. Maps are keyed by `taskId`; removal = writing the map without the entry (no tombstones). Guard sets are pruned on write to live entities (open tasks / present snapshots) that `ceo-inbox-sent-observe` already loads. The digest *render* helpers stay and read JSON.

**Tech Stack:** TypeScript (ESM, Node 24+), Vitest, `ConfigStore` (`src/memory/config-store.ts`, KG-backed KV storing string values).

## Global Constraints

- ESM only — `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`.
- No `any` — proper types / discriminated unions. Array element access under strict null checks needs `!` (e.g. `arr[0]!`).
- Skills return `{ success: true, data }` / `{ success: false, error }` — never throw out of `execute()`.
- No `console.log` — use `ctx.log` (pino). No empty `catch {}` — log + continue or propagate.
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json run typecheck` before each commit touching `.ts`.
- Run tests with `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test <path>`.
- Commit messages: conventional (`refactor:`/`test:`/`docs:`/`chore:`), signed off (`-s`), NO `Co-Authored-By`, NO Claude attribution.
- Bump `version` in each touched `skill.json` (patch — behavior-preserving refactor).
- ConfigStore stores **strings** — every store is `JSON.stringify`'d on write, `JSON.parse`'d on read; a missing/garbage record parses to empty (never throw on parse).
- Digest UX must be **byte-identical** to today's rendering (acceptance criterion).

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json` (branch `chore/1438-learning-state-json`). All paths below are repo-relative to it.

---

## File structure

- **Create** `skills/_shared/learning-state.ts` — types, config-key constants, JSON accessors, note composers.
- **Create** `skills/_shared/learning-state.test.ts` — unit tests for accessors + composers.
- **Modify** `skills/_shared/learning-digest.ts` — keep only `renderVoiceGuideSection` / `renderCompletionSection`; import `CompletionDigestItem` from `learning-state.ts`; delete the parsers/prune/remove.
- **Modify** `skills/_shared/task-completion-risk.ts` — keep risk logic; delete `parseCompletionCandidates`, `formatUndoNote`, `formatConfirmNote`, `ParsedCompletionCandidate`.
- **Modify** `skills/_shared/sent-observe-match.ts` — delete `formatCompletionCandidateBlock`; keep matching + `formatDiffBlock` + `trimEvidenceDoc`.
- **Modify** `skills/voice-learn/handler.ts` (+ `handler.test.ts`, `skill.json`) — proposal → config.
- **Modify** `skills/ceo-inbox-sent-observe/handler.ts` (+ `handler.test.ts`, `skill.json`) — candidates + asked + matched guards → config.
- **Modify** `skills/task-completion-from-sent/handler.ts` (+ `handler.test.ts`, `skill.json`) — read candidates from config, consume-by-delete; digest → config.
- **Modify** `skills/list-learning-digest/handler.ts` (+ `handler.test.ts`, `skill.json`) — read proposal + digest from config.
- **Modify** `skills/resolve-learning-digest/handler.ts` (+ `handler.test.ts`, `skill.json`) — resolve proposal + digest in config.
- **Delete** `skills/_shared/learning-digest.test.ts` cases for the removed parsers; keep render tests.
- **Modify** `skills/_shared/task-completion-risk.test.ts` — drop candidate parse/format cases.
- **Modify** `skills/_shared/sent-observe-match.test.ts` — drop `formatCompletionCandidateBlock` case.
- **Modify** `docs/adr/029-passive-email-observation-and-counterfactual-competence.md`, `docs/specs/04-channels.md`, `docs/specs/13-office-identity.md`, `docs/specs/19-tasks-and-backlog.md`.
- **Modify** `CHANGELOG.md`.

---

## Task 1: `learning-state.ts` shared module

**Files:**
- Create: `skills/_shared/learning-state.ts`
- Test: `skills/_shared/learning-state.test.ts`

**Interfaces:**
- Consumes: `ConfigStore` from `../../src/memory/config-store.js` (`get(ns,key): Promise<string|null>`, `set(ns,key,value): Promise<void>`); `MatchConfidence` from `./sent-observe-match.js`.
- Produces (all imported by later tasks):
  - Namespace/keys: `LEARNING_STATE_NAMESPACE = 'ceo_inbox'`, `COMPLETION_CANDIDATES_KEY`, `COMPLETION_DIGEST_KEY`, `VOICE_PROPOSAL_KEY`, `MATCHED_DRAFT_IDS_KEY`, `ASKED_TASK_IDS_KEY`.
  - Types: `CompletionCandidate`, `CompletionCandidateMap`, `CompletionDigestItem` (`{ kind: 'undo'|'confirm'; taskId: string; taskTitle: string; note: string }`), `CompletionDigestMap`, `VoiceGuideProposal` (`{ status: string; generatedAt: string; guide: string }`).
  - Accessors: `readCompletionCandidates(store): Promise<CompletionCandidateMap>`, `writeCompletionCandidates(store, map): Promise<void>`, `readCompletionDigest(store): Promise<CompletionDigestMap>`, `writeCompletionDigest(store, map): Promise<void>`, `readVoiceProposal(store): Promise<VoiceGuideProposal | null>`, `writeVoiceProposal(store, proposal | null): Promise<void>`, `readIdSet(store, key): Promise<Set<string>>`, `writeIdSet(store, key, ids): Promise<void>`.
  - Composers: `composeUndoNote({ taskTitle, recipient, sentAt }): string`, `composeConfirmNote({ taskTitle, recipient }): string`.
  - Helper for later tasks: `digestMapToItems(map): CompletionDigestItem[]`.

- [ ] **Step 1: Write the failing test**

Create `skills/_shared/learning-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ConfigStore } from '../../src/memory/config-store.js';
import {
  LEARNING_STATE_NAMESPACE,
  COMPLETION_CANDIDATES_KEY,
  COMPLETION_DIGEST_KEY,
  VOICE_PROPOSAL_KEY,
  ASKED_TASK_IDS_KEY,
  readCompletionCandidates,
  writeCompletionCandidates,
  readCompletionDigest,
  writeCompletionDigest,
  readVoiceProposal,
  writeVoiceProposal,
  readIdSet,
  writeIdSet,
  composeUndoNote,
  composeConfirmNote,
  digestMapToItems,
  type CompletionCandidateMap,
  type CompletionDigestMap,
} from './learning-state.js';

// Minimal in-memory ConfigStore double: only get/set, keyed by config key (namespace fixed).
function fakeStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const store = {
    get: async (_ns: string, key: string) => values.get(key) ?? null,
    set: async (_ns: string, key: string, value: string) => { values.set(key, value); },
  } as unknown as ConfigStore;
  return { store, values };
}

describe('learning-state config accessors', () => {
  it('uses the ceo_inbox namespace', () => {
    expect(LEARNING_STATE_NAMESPACE).toBe('ceo_inbox');
  });

  it('reads an empty map when the key is unset or garbage', async () => {
    const { store } = fakeStore({ [COMPLETION_CANDIDATES_KEY]: 'not json' });
    expect(await readCompletionCandidates(store)).toEqual({});
    expect(await readCompletionDigest(fakeStore().store)).toEqual({});
    expect(await readVoiceProposal(fakeStore().store)).toBeNull();
    expect([...(await readIdSet(fakeStore().store, ASKED_TASK_IDS_KEY))]).toEqual([]);
  });

  it('round-trips a completion-candidate map and removes by writing the map without the entry', async () => {
    const { store, values } = fakeStore();
    const map: CompletionCandidateMap = {
      t1: { messageId: 'm1', confidence: 'high', reason: 'r', sentAt: 's', subject: 'sub', recipients: ['a@x'], taskTitle: 'T1' },
      t10: { messageId: 'm10', confidence: 'low', reason: 'r', sentAt: 's', subject: 'sub', recipients: ['b@x'], taskTitle: 'T10' },
    };
    await writeCompletionCandidates(store, map);
    expect(JSON.parse(values.get(COMPLETION_CANDIDATES_KEY)!)).toEqual(map);

    // Remove t1 by writing the map without it — t10 is untouched (no boundary bleed).
    const { t1: _drop, ...rest } = await readCompletionCandidates(store);
    void _drop;
    await writeCompletionCandidates(store, rest);
    const after = await readCompletionCandidates(store);
    expect(after.t1).toBeUndefined();
    expect(after.t10).toBeDefined();
  });

  it('supersedes a pending voice proposal by whole-object write', async () => {
    const { store } = fakeStore();
    await writeVoiceProposal(store, { status: 'pending', generatedAt: 'g1', guide: 'first' });
    await writeVoiceProposal(store, { status: 'pending', generatedAt: 'g2', guide: 'second' });
    expect(await readVoiceProposal(store)).toEqual({ status: 'pending', generatedAt: 'g2', guide: 'second' });
    await writeVoiceProposal(store, null);
    expect(await readVoiceProposal(store)).toBeNull();
  });

  it('round-trips an id set', async () => {
    const { store } = fakeStore();
    await writeIdSet(store, ASKED_TASK_IDS_KEY, new Set(['a', 'b']));
    expect([...(await readIdSet(store, ASKED_TASK_IDS_KEY))].sort()).toEqual(['a', 'b']);
  });

  it('round-trips a digest map and flattens to items carrying their taskId', async () => {
    const { store } = fakeStore();
    const map: CompletionDigestMap = {
      t1: { kind: 'undo', taskId: 't1', taskTitle: 'Follow up', note: 'n1' },
      t2: { kind: 'confirm', taskId: 't2', taskTitle: 'Plan AGM', note: 'n2' },
    };
    await writeCompletionDigest(store, map);
    const items = digestMapToItems(await readCompletionDigest(store));
    expect(items).toHaveLength(2);
    expect(items[0]!.taskId).toBe('t1');
    expect(items.find((i) => i.taskId === 't2')!.kind).toBe('confirm');
  });

  it('composes undo/confirm note text verbatim to the pre-migration copy', () => {
    expect(composeUndoNote({ taskTitle: 'Ship', recipient: 'a@x', sentAt: '2026-07-01T12:00:00.000Z' }))
      .toBe('Marked *Ship* done — you emailed a@x (2026-07-01). Undo?');
    expect(composeConfirmNote({ taskTitle: 'Ship', recipient: 'a@x' }))
      .toBe('Did emailing a@x complete *Ship*?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/_shared/learning-state.test.ts`
Expected: FAIL — cannot resolve `./learning-state.js`.

- [ ] **Step 3: Write the module**

Create `skills/_shared/learning-state.ts`:

```ts
// Config-store JSON accessors for the email-observation learning subsystem (#1438).
//
// The queue/status/guard machine-state that used to ride inside OKF markdown doc bodies
// (completion candidates, digest items, the voice proposal, the matched/asked guard sets) now
// lives here as whole-object JSON values under the `ceo_inbox` namespace. Removal = writing the
// map without the entry (no per-item tombstones, no regex parse). Prose evidence
// (pending-diffs.md), draft snapshots, and shadow docs stay in OKF (see ADR-029).

import type { ConfigStore } from '../../src/memory/config-store.js';
import type { MatchConfidence } from './sent-observe-match.js';

/** Same namespace as the watermark/idle-backoff/checkpoint/dismiss-cooldown keys. */
export const LEARNING_STATE_NAMESPACE = 'ceo_inbox';

export const COMPLETION_CANDIDATES_KEY = 'sent_observe.completion_candidates';
export const COMPLETION_DIGEST_KEY = 'sent_observe.completion_digest';
export const VOICE_PROPOSAL_KEY = 'voice_learn.proposal';
export const MATCHED_DRAFT_IDS_KEY = 'sent_observe.matched_draft_ids';
export const ASKED_TASK_IDS_KEY = 'sent_observe.asked_task_ids';

/** A task-completion candidate queued by sent-observe, consumed by task-completion-from-sent. */
export interface CompletionCandidate {
  messageId: string;
  confidence: MatchConfidence;
  reason: string;
  sentAt: string;
  subject: string;
  recipients: string[];
  taskTitle: string;
}
/** Keyed by taskId — one open task has at most one live candidate, so re-adds are idempotent. */
export type CompletionCandidateMap = Record<string, CompletionCandidate>;

/** An undo/confirm item shown in the learning digest. `taskId` is carried in the value so the
 *  render helpers (which take a flat array) keep emitting the reply-command per item unchanged. */
export interface CompletionDigestItem {
  kind: 'undo' | 'confirm';
  taskId: string;
  taskTitle: string;
  note: string;
}
export type CompletionDigestMap = Record<string, CompletionDigestItem>;

export interface VoiceGuideProposal {
  status: string;
  generatedAt: string;
  guide: string;
}

/** Parse a stored JSON value, treating unset/garbage as absent — data loss (a dropped item) is
 *  worse than over-retention, and a parse throw must never escape into a skill failure. */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readCompletionCandidates(store: ConfigStore): Promise<CompletionCandidateMap> {
  return parseJson<CompletionCandidateMap>(await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY)) ?? {};
}
export async function writeCompletionCandidates(store: ConfigStore, map: CompletionCandidateMap): Promise<void> {
  await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_CANDIDATES_KEY, JSON.stringify(map));
}

export async function readCompletionDigest(store: ConfigStore): Promise<CompletionDigestMap> {
  return parseJson<CompletionDigestMap>(await store.get(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY)) ?? {};
}
export async function writeCompletionDigest(store: ConfigStore, map: CompletionDigestMap): Promise<void> {
  await store.set(LEARNING_STATE_NAMESPACE, COMPLETION_DIGEST_KEY, JSON.stringify(map));
}

export async function readVoiceProposal(store: ConfigStore): Promise<VoiceGuideProposal | null> {
  return parseJson<VoiceGuideProposal>(await store.get(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY));
}
export async function writeVoiceProposal(store: ConfigStore, proposal: VoiceGuideProposal | null): Promise<void> {
  await store.set(LEARNING_STATE_NAMESPACE, VOICE_PROPOSAL_KEY, JSON.stringify(proposal));
}

export async function readIdSet(store: ConfigStore, key: string): Promise<Set<string>> {
  const arr = parseJson<string[]>(await store.get(LEARNING_STATE_NAMESPACE, key));
  return new Set(Array.isArray(arr) ? arr : []);
}
export async function writeIdSet(store: ConfigStore, key: string, ids: Set<string>): Promise<void> {
  await store.set(LEARNING_STATE_NAMESPACE, key, JSON.stringify([...ids]));
}

/** Flatten the digest map to the array the render helpers consume, preserving insertion order. */
export function digestMapToItems(map: CompletionDigestMap): CompletionDigestItem[] {
  return Object.values(map);
}

/** Human note for an auto-completed task's undo affordance. Verbatim to the pre-migration
 *  formatUndoNote copy so the digest UX is byte-identical. */
export function composeUndoNote(params: { taskTitle: string; recipient: string; sentAt: string }): string {
  const when = params.sentAt ? ` (${params.sentAt.slice(0, 10)})` : '';
  return `Marked *${params.taskTitle}* done — you emailed ${params.recipient}${when}. Undo?`;
}

/** Human note for a confirm-in-digest item. Verbatim to the pre-migration formatConfirmNote copy. */
export function composeConfirmNote(params: { taskTitle: string; recipient: string }): string {
  return `Did emailing ${params.recipient} complete *${params.taskTitle}*?`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/_shared/learning-state.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/_shared/learning-state.ts skills/_shared/learning-state.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "feat(learning-state): config-store JSON accessors for learning machine-state (#1438)"
```

---

## Task 2: Voice proposal → config (`voice-learn`, `list`, `resolve`)

Migrate the voice guide proposal (Store A) from `pending-proposals.md` to `voice_learn.proposal`. `voice-learn` writes (supersede = whole write); `list-learning-digest` reads; `resolve-learning-digest` `approve_voice`/`dismiss_voice` read + clear. The dismiss-cooldown (`voice_learn.dismissed`) and diffs-checkpoint keys are untouched.

**Files:**
- Modify: `skills/voice-learn/handler.ts`, `skills/voice-learn/handler.test.ts`, `skills/voice-learn/skill.json`
- Modify: `skills/list-learning-digest/handler.ts`, `skills/list-learning-digest/handler.test.ts`
- Modify: `skills/resolve-learning-digest/handler.ts`, `skills/resolve-learning-digest/handler.test.ts`

**Interfaces:**
- Consumes from Task 1: `readVoiceProposal`, `writeVoiceProposal`, `VOICE_PROPOSAL_KEY`, `LEARNING_STATE_NAMESPACE`.
- Produces: `voice_learn.proposal` config key holding `VoiceGuideProposal | null`. `voice-learn` still exports `CONFIG_NAMESPACE`, `DISMISSED_KEY`, `DIFFS_CHECKPOINT_KEY`. `PENDING_PROPOSALS_PATH` / `PENDING_PROPOSALS_TYPE` are **removed**.

- [ ] **Step 1: Update `voice-learn/handler.test.ts` (failing)**

The existing test asserts a `## Guide Proposal` block lands in `pending-proposals.md`. Change it to assert the proposal object is written to `voice_learn.proposal`. Add the `makeMem` config double (copy the one from `resolve-learning-digest/handler.test.ts` lines 8–32, using `CONFIG_NAMESPACE`), wire `entityMemory: mem` into the ctx, and replace the doc assertion:

```ts
import { VOICE_PROPOSAL_KEY, LEARNING_STATE_NAMESPACE } from '../_shared/learning-state.js';
// ...
// after a successful proposal run:
const stored = JSON.parse(mem.__values.get(VOICE_PROPOSAL_KEY)!);
expect(stored.status).toBe('pending');
expect(stored.guide).toContain(/* the expected guide text */);
// supersede: a second run with newer evidence overwrites the same key (no accumulation)
```

Keep the existing checkpoint / dismiss-cooldown assertions (those keys and their behavior are unchanged). Ensure the test no longer references `PENDING_PROPOSALS_PATH`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/voice-learn/handler.test.ts`
Expected: FAIL — `VOICE_PROPOSAL_KEY` unused by handler / value undefined.

- [ ] **Step 3: Update `voice-learn/handler.ts`**

Replace the proposals-doc read/write with a config write. Concretely:

- Remove imports of `pruneGuideProposals` and `PENDING_PROPOSALS_PATH`/`PENDING_PROPOSALS_TYPE`; remove the `export const PENDING_PROPOSALS_PATH/TYPE` lines.
- Add `import { writeVoiceProposal } from '../_shared/learning-state.js';`.
- Delete the `const existing = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);` read (superseding is now an unconditional whole-object write).
- Replace the block-build + create/update branch (the `const block = ...` through the `ctx.workingDocs.create/update` if/else) with:

```ts
// Supersede any prior proposal by writing the single proposal object whole. The checkpoint
// (below) is what stops the SAME evidence being re-proposed; this write replaces a stale
// still-pending proposal with the fresher one. configStore is guaranteed here — a proposal
// requires entityMemory to persist state; if it's unavailable we cannot record the proposal.
if (!configStore) {
  ctx.log.warn({}, 'voice-learn: config store unavailable — cannot record proposal this run');
  return { success: true, data: { pairs_considered: newPairs.length, proposed: false, reason: 'no-config-store' } };
}
await writeVoiceProposal(configStore, {
  status: 'pending',
  generatedAt: new Date().toISOString(),
  guide,
});
```

Note: `configStore` is created earlier in the handler from `ctx.entityMemory` (the checkpoint block). It is `ConfigStore | null`. The checkpoint-advance block that follows already guards on `if (configStore)`, so it is unchanged.

- [ ] **Step 4: Update `list-learning-digest/handler.ts`**

- Remove `import { PENDING_PROPOSALS_PATH } from '../voice-learn/handler.js';` and the `parseVoiceGuideProposal` import.
- Add `import { ConfigStore } from '../../src/memory/config-store.js';` and `import { readVoiceProposal } from '../_shared/learning-state.js';`.
- Replace the proposal read: guard on `ctx.entityMemory`; when present, `const store = new ConfigStore(ctx.entityMemory, ctx.log); const proposal = await readVoiceProposal(store);` and use `proposal?.status === 'pending' ? proposal.guide : null` for the guide. (Digest read stays markdown in this task — migrated in Task 4.)

- [ ] **Step 5: Update `resolve-learning-digest/handler.ts` voice branch**

In the `approve_voice`/`dismiss_voice` branch (currently reads `PENDING_PROPOSALS_PATH` + `parseVoiceGuideProposal`):
- Remove the `PENDING_PROPOSALS_PATH` import and `parseVoiceGuideProposal`/`pruneGuideProposals` imports.
- Build the `ConfigStore` once at the top of the branch: `const store = new ConfigStore(ctx.entityMemory, ctx.log);` (already imported).
- Replace the doc read with `const proposal = await readVoiceProposal(store); if (!proposal || proposal.status !== 'pending') return { success: false, error: 'No pending voice guide proposal' };`
- `approve_voice`: after `executiveProfileService.update(...)`, replace the `pruneGuideProposals` + doc update with `await writeVoiceProposal(store, null);`.
- `dismiss_voice`: keep the existing `DISMISSED_KEY` cooldown write (it already uses `store`); replace the `pruneGuideProposals` + doc update with `await writeVoiceProposal(store, null);`.
- Add `readVoiceProposal, writeVoiceProposal` to the `learning-state.js` import.

- [ ] **Step 6: Update `list` + `resolve` tests**

`list-learning-digest/handler.test.ts`: seed the proposal via config (`entityMemory` double + `VOICE_PROPOSAL_KEY`) instead of a `pending-proposals.md` doc; assert `voice_guide` still renders. `resolve-learning-digest/handler.test.ts` (`approve`/`dismiss` cases): seed `VOICE_PROPOSAL_KEY` in `mem.__values` (JSON string), drop the `pending-proposals.md` doc; after resolve, assert `mem.__values.get(VOICE_PROPOSAL_KEY)` is `'null'` and (dismiss) `DISMISSED_KEY` contains `guide`.

- [ ] **Step 7: Run the three test files**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/voice-learn skills/list-learning-digest skills/resolve-learning-digest`
Expected: PASS. (`resolve` completion-digest cases still use markdown here — untouched until Task 4.)

- [ ] **Step 8: Typecheck + commit**

(Version bumps are deferred to Task 8 — one bump per skill per PR, not per task/commit.)

Run typecheck, then:
```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/voice-learn skills/list-learning-digest skills/resolve-learning-digest
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "refactor(voice-learn): store voice proposal in config-store, not pending-proposals.md (#1438)"
```

---

## Task 3: Completion candidates + asked-task guard → config (`sent-observe` write, `task-completion` consume)

Migrate the candidate queue (Store C) and the `asked_task_ids` guard. `ceo-inbox-sent-observe` writes candidates + the pruned asked-guard to config (ordered so a held watermark neither loses nor double-surfaces a candidate); `task-completion-from-sent` reads the map and **removes on consume**. The completion digest write stays markdown until Task 4. `matched_draft_ids` stays regex-derived until Task 5.

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/handler.ts`, `skills/ceo-inbox-sent-observe/handler.test.ts`, `skills/ceo-inbox-sent-observe/skill.json`
- Modify: `skills/task-completion-from-sent/handler.ts`, `skills/task-completion-from-sent/handler.test.ts`, `skills/task-completion-from-sent/skill.json`

**Interfaces:**
- Consumes from Task 1: `readCompletionCandidates`, `writeCompletionCandidates`, `readIdSet`, `writeIdSet`, `ASKED_TASK_IDS_KEY`, `CompletionCandidateMap`, `CompletionCandidate`.
- Produces: `sent_observe.completion_candidates` (map) + `sent_observe.asked_task_ids` (array). `PENDING_COMPLETIONS_PATH` / `PENDING_COMPLETIONS_TYPE` are **removed** from `sent-observe/handler.ts`.

- [ ] **Step 1: Update `sent-observe/handler.test.ts` (failing)**

Change the `persists task-completion candidates for open CEO tasks` test: replace the `ctx.__docs.get(PENDING_COMPLETIONS_PATH)` assertion with a config-map assertion:

```ts
import { COMPLETION_CANDIDATES_KEY, ASKED_TASK_IDS_KEY } from '../_shared/learning-state.js';
// ...
const stored = JSON.parse(ctx.__mem.__values.get(COMPLETION_CANDIDATES_KEY)!);
expect(stored['task-ceo-1']).toBeDefined();
expect(stored['task-ceo-1'].confidence).toBe('high');
const asked = JSON.parse(ctx.__mem.__values.get(ASKED_TASK_IDS_KEY)!);
expect(asked).toContain('task-ceo-1');
```

Add a new test for the held-watermark guard-atomicity criterion:

```ts
it('does not persist the asked-guard when the candidate write is held (no candidate lost)', async () => {
  // A matched task, but the completion_candidates config write throws → completionsPersisted=false
  // → watermark held AND asked_task_ids NOT written, so next run re-matches and re-adds.
  // Drive the failure by making storeFact reject writes to COMPLETION_CANDIDATES_KEY.
  // (Implement by wrapping the mem double's storeFact to throw for that label.)
  // Assert: watermark_advanced_to === null, asked_task_ids unset (or lacks the task).
});
```

Also add a pruning test:

```ts
it('prunes asked_task_ids to currently-open tasks on write', async () => {
  // Seed ASKED_TASK_IDS_KEY with ['closed-task', 'task-ceo-1']; openTasks returns only task-ceo-1.
  // After a run, stored asked set excludes 'closed-task'.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `sent-observe/handler.ts`**

- Remove `formatCompletionCandidateBlock` from the `sent-observe-match.js` import; add `import { readCompletionCandidates, writeCompletionCandidates, readIdSet, writeIdSet, ASKED_TASK_IDS_KEY, type CompletionCandidateMap, type CompletionCandidate } from '../_shared/learning-state.js';`.
- Remove `export const PENDING_COMPLETIONS_PATH/TYPE`; remove the `pendingCompletions = await ensureDoc(...)` call; remove `extractAskedTaskIds` (function + its call). Keep `PENDING_DIFFS_PATH`, `extractMatchedDraftIds` (removed in Task 5).
- Seed the asked guard from config: `const store = new ConfigStore(...)` already exists; add `const alreadyAskedTaskIds = await readIdSet(store, ASKED_TASK_IDS_KEY);` (replacing the doc-derived seed).
- Replace `completionChunks: string[]` with `const newCandidates: CompletionCandidateMap = {};`. In the task-match loop, replace `completionChunks.push(formatCompletionCandidateBlock(tm))` with:

```ts
newCandidates[tm.taskId] = {
  messageId: tm.messageId,
  confidence: tm.confidence,
  reason: tm.reason,
  sentAt: tm.sentAt,
  subject: tm.sentSubject,
  recipients: tm.sentRecipients,
  taskTitle: tm.taskTitle,
} satisfies CompletionCandidate;
alreadyAskedTaskIds.add(tm.taskId);
taskCandidates += 1;
```

- Replace the `pending-completions.md` `appendAndTrimDoc` call with a config merge-write, ordered after the diffs write:

```ts
// Persist the candidate queue (config JSON) — replaces the pending-completions.md append.
// Merge onto a fresh read so we don't clobber a concurrent removal by task-completion; keyed
// by taskId so a held-watermark retry re-adds idempotently. A hard write failure holds the
// watermark (completionsPersisted=false) — the queue must persist before we forget the sends.
let completionsPersisted = true;
if (Object.keys(newCandidates).length > 0) {
  try {
    const existing = await readCompletionCandidates(store);
    await writeCompletionCandidates(store, { ...existing, ...newCandidates });
  } catch (err) {
    completionsPersisted = false;
    ctx.log.warn({ err }, 'ceo-inbox-sent-observe: completion-candidate write failed — holding watermark');
  }
}
```

- Keep `diffsPersisted` (the pending-diffs append). Update `evidencePersisted = diffsPersisted && completionsPersisted;` (same shape, `completionsPersisted` is now the config write, not a doc append).
- After the watermark-advance decision is computed but gated on the same `advanceOk`, write the asked guard ONLY when the queue persisted, pruned to open tasks:

```ts
// Persist the asked-task guard AFTER the queue, and only when the queue persisted — writing the
// guard while the queue write failed would let next run skip re-matching and LOSE the candidate.
// Prune to currently-open tasks (Joseph's retention choice): a completed/cancelled task drops out
// of the guard; re-surfacing a since-reopened task is harmless (original send is below the
// watermark; task-completion re-validates eligibility).
if (completionsPersisted) {
  const openIds = new Set(openTasks.map((t) => t.id));
  const prunedAsked = new Set([...alreadyAskedTaskIds].filter((id) => openIds.has(id)));
  try {
    await writeIdSet(store, ASKED_TASK_IDS_KEY, prunedAsked);
  } catch (err) {
    ctx.log.warn({ err }, 'ceo-inbox-sent-observe: asked-guard write failed (queue already persisted; guard re-derives next run)');
  }
}
```

Note the guard-write placement: it must run whenever `completionsPersisted` (independent of `advanceOk`), because even a held watermark that persisted the queue wants the guard updated. Put it right after the `completionsPersisted` block, before the watermark-advance block.

- [ ] **Step 4: Update `task-completion-from-sent/handler.ts`**

- Remove imports of `PENDING_COMPLETIONS_PATH`, `parseCompletionCandidates`, `candidateBlock`, `markCandidateProcessed` (delete the two local functions). Add `import { ConfigStore } from '../../src/memory/config-store.js';` and `import { readCompletionCandidates, writeCompletionCandidates, type CompletionCandidateMap } from '../_shared/learning-state.js';`.
- Require `ctx.entityMemory` in the capability guard (`if (!ctx.taskRepo || !ctx.workingDocs || !ctx.sensitivityClassifier || !ctx.entityMemory)`).
- Replace the `pendingDoc` read + `parseCompletionCandidates` with:

```ts
const store = new ConfigStore(ctx.entityMemory, ctx.log);
const candidateMap = await readCompletionCandidates(store);
const candidates = Object.entries(candidateMap).map(([taskId, c]) => ({ taskId, ...c }));
if (candidates.length === 0) {
  return { success: true, data: { auto_completed: 0, queued_confirm: 0, skipped: 0 } };
}
const remaining: CompletionCandidateMap = { ...candidateMap };
```

- In the loop, replace every `body = markCandidateProcessed(...)` / status-mark with `delete remaining[candidate.taskId];` (consume-by-remove — auto-completed, confirm-queued, and skipped-ineligible all drop from the queue; the `asked_task_ids` guard stops re-surfacing). The `candidate.confidence`, `candidate.messageId`, etc. field names are unchanged (the flattened object has the same shape as `ParsedCompletionCandidate` minus `status`).
- Replace the digest chunk collection (`digestChunks`) — for Task 3 keep the existing markdown `appendDigest` path unchanged (it still uses `formatUndoNote`/`formatConfirmNote`); those move to config in Task 4. So `digestChunks.push(formatUndoNote({...}))` / `formatConfirmNote({...})` stay as-is here.
- Replace the final `if (body !== pendingDoc.body) { ctx.workingDocs.update(PENDING_COMPLETIONS_PATH, ...) }` with:

```ts
if (Object.keys(remaining).length !== Object.keys(candidateMap).length) {
  await writeCompletionCandidates(store, remaining);
}
```

- [ ] **Step 5: Update `task-completion-from-sent/handler.test.ts`**

Replace the `PENDING` markdown doc seed with a config candidate map seed. Add the `entityMemory` config double (copy `makeMem` from `resolve` test, using `CONFIG_NAMESPACE = 'ceo_inbox'`; seed `COMPLETION_CANDIDATES_KEY` with the three candidates as a JSON map keyed by the three task UUIDs). Assertions:
- `auto_completed`/`queued_confirm` counts unchanged (still 1/2).
- After the run, `JSON.parse(mem.__values.get(COMPLETION_CANDIDATES_KEY)!)` is `{}` (all three consumed).
- The digest doc (`COMPLETION_DIGEST_PATH`, still markdown in Task 3) still contains the three `Undo`/`Confirm` blocks (keep those assertions).
- Update the `skips a candidate whose task is no longer CEO-owned` case: assert the ineligible task is removed from the config map (not a `skipped_ineligible` marker) and is not completed.

- [ ] **Step 6: Run both test files**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/ceo-inbox-sent-observe skills/task-completion-from-sent`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

(Version bumps deferred to Task 8.)

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/ceo-inbox-sent-observe skills/task-completion-from-sent
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "refactor(sent-observe): completion queue + asked-guard in config-store, consume-by-delete (#1438)"
```

---

## Task 4: Completion digest → config (`task-completion` write, `list`/`resolve` read/resolve)

Migrate the digest (Store B) from `completion-digest.md` to `sent_observe.completion_digest`. `task-completion-from-sent` writes items (keyed by taskId); `list-learning-digest` renders from the map; `resolve-learning-digest` undo/confirm/dismiss remove by taskId.

**Files:**
- Modify: `skills/task-completion-from-sent/handler.ts`, `skills/task-completion-from-sent/handler.test.ts`
- Modify: `skills/list-learning-digest/handler.ts`, `skills/list-learning-digest/handler.test.ts`
- Modify: `skills/resolve-learning-digest/handler.ts`, `skills/resolve-learning-digest/handler.test.ts`
- Modify: `skills/_shared/learning-digest.ts` (render helpers now import `CompletionDigestItem` from `learning-state.ts`)

**Interfaces:**
- Consumes from Task 1: `readCompletionDigest`, `writeCompletionDigest`, `digestMapToItems`, `composeUndoNote`, `composeConfirmNote`, `CompletionDigestItem`, `CompletionDigestMap`.
- Produces: `sent_observe.completion_digest` (map). `COMPLETION_DIGEST_PATH` / `COMPLETION_DIGEST_TYPE` are **removed** from `task-completion-from-sent/handler.ts`.

- [ ] **Step 1: Point `learning-digest.ts` render helpers at the new type**

In `skills/_shared/learning-digest.ts` add `import type { CompletionDigestItem } from './learning-state.js';` and delete the local `CompletionDigestItem` interface. (Full dead-code removal is Task 6; here only the type source changes so the two render helpers compile against the shared type. `renderCompletionSection` already reads only `kind`/`taskId`/`note` — all present on the shared type.)

- [ ] **Step 2: Update `task-completion-from-sent/handler.test.ts` (failing)**

Replace the `COMPLETION_DIGEST_PATH` doc assertions with config-map assertions:

```ts
import { COMPLETION_DIGEST_KEY } from '../_shared/learning-state.js';
// ...
const digest = JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!);
expect(digest['11111111-1111-4111-8111-111111111111'].kind).toBe('undo');
expect(digest['22222222-2222-4222-8222-222222222222'].kind).toBe('confirm');
expect(digest['33333333-3333-4333-8333-333333333333'].kind).toBe('confirm');
```

- [ ] **Step 3: Update `task-completion-from-sent/handler.ts`**

- Remove `COMPLETION_DIGEST_PATH`/`COMPLETION_DIGEST_TYPE` exports and the `appendDigest` function; remove `formatUndoNote`/`formatConfirmNote` imports. Add `readCompletionDigest, writeCompletionDigest, composeUndoNote, composeConfirmNote, type CompletionDigestMap, type CompletionDigestItem` to the `learning-state.js` import.
- Replace `const digestChunks: string[] = [];` with `const digestAdds: CompletionDigestItem[] = [];`.
- In the auto-complete branch, replace the `formatUndoNote` push with:

```ts
digestAdds.push({
  kind: 'undo',
  taskId: task.id,
  taskTitle: task.title || candidate.taskTitle,
  note: composeUndoNote({ taskTitle: task.title || candidate.taskTitle, recipient, sentAt: candidate.sentAt }),
});
```

- In the confirm branch, replace the `formatConfirmNote` push with:

```ts
digestAdds.push({
  kind: 'confirm',
  taskId: task.id,
  taskTitle: task.title || candidate.taskTitle,
  note: composeConfirmNote({ taskTitle: task.title || candidate.taskTitle, recipient }),
});
```

- Replace the `if (digestChunks.length > 0) { await appendDigest(...) }` with a read-merge-write:

```ts
if (digestAdds.length > 0) {
  const digestMap = await readCompletionDigest(store);
  for (const item of digestAdds) digestMap[item.taskId] = item;
  await writeCompletionDigest(store, digestMap);
}
```

(`store` is the `ConfigStore` created in Task 3.)

- [ ] **Step 4: Update `list-learning-digest/handler.ts`**

- Remove `COMPLETION_DIGEST_PATH` import + `parseCompletionDigest` import. Add `readCompletionDigest, digestMapToItems` to the `learning-state.js` import.
- Replace `const completionsDoc = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH); const completion_items = parseCompletionDigest(completionsDoc?.body ?? '');` with (reusing the `store` built for the proposal read in Task 2): `const completion_items = ctx.entityMemory ? digestMapToItems(await readCompletionDigest(store)) : [];`.
- `renderCompletionSection(completion_items)` is unchanged.

- [ ] **Step 5: Update `resolve-learning-digest/handler.ts` completion branch**

- Remove `COMPLETION_DIGEST_PATH` import + `parseCompletionDigest`/`removeCompletionBlock` imports. Add `readCompletionDigest, writeCompletionDigest` to the `learning-state.js` import.
- Replace `const digest = await ctx.workingDocs.read(COMPLETION_DIGEST_PATH); if (!digest) ...` with `const digestMap = await readCompletionDigest(store); const item = digestMap[taskId]; if (!item || item.kind !== expectedKind) return { success: false, error: \`No actionable ${expectedKind} item for task ${taskId}\` };`.
- In each of `undo_completion` / `confirm_completion` / `dismiss_completion`, after the task mutation succeeds (unchanged: `reopenTask` null-guard, `completeTask` not-found-guard), replace the `removeCompletionBlock` + `ctx.workingDocs.update(COMPLETION_DIGEST_PATH, ...)` with:

```ts
const { [taskId]: _removed, ...rest } = digestMap;
void _removed;
await writeCompletionDigest(store, rest);
```

Keep the ordering: for `undo_completion`, still call `reopenTask` first and bail (without writing) if it returns null; for `confirm_completion`, still `getTask` + not-found guard before `completeTask`.

- [ ] **Step 6: Update `list` + `resolve` tests**

`list-learning-digest/handler.test.ts`: seed `COMPLETION_DIGEST_KEY` as a JSON map; assert `completion_items` + `sections_markdown` render identically (e.g. still contains `undo completion <id>` / `confirm completion <id>` reply commands). `resolve-learning-digest/handler.test.ts` undo cases: seed `COMPLETION_DIGEST_KEY` (JSON map with a `t1` undo item) instead of the `completion-digest.md` doc; after `undo_completion`, assert `JSON.parse(mem.__values.get(COMPLETION_DIGEST_KEY)!).t1` is undefined; for the reopenTask-returns-null case, assert the map still contains `t1` (item preserved, `writeCompletionDigest` not called).

- [ ] **Step 7: Run the affected test files**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/task-completion-from-sent skills/list-learning-digest skills/resolve-learning-digest`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

(Version bumps deferred to Task 8.)

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/task-completion-from-sent skills/list-learning-digest skills/resolve-learning-digest skills/_shared/learning-digest.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "refactor(learning-digest): completion digest in config-store, resolve by map delete (#1438)"
```

---

## Task 5: `matched_draft_ids` guard → config (`sent-observe`)

Migrate the draft-match guard (Store D) from a regex over `pending-diffs.md` to `sent_observe.matched_draft_ids`. `pending-diffs.md` stays OKF prose. Crucially, a draft whose full-body fetch FAILED (no diff persisted) must be EXCLUDED from the stored set so it re-matches next run — mirroring today's re-derive-from-doc behavior.

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/handler.ts`, `skills/ceo-inbox-sent-observe/handler.test.ts`

**Interfaces:**
- Consumes from Task 1: `readIdSet`, `writeIdSet`, `MATCHED_DRAFT_IDS_KEY`.
- Produces: `sent_observe.matched_draft_ids` (array). `extractMatchedDraftIds` is **deleted**.

- [ ] **Step 1: Update `sent-observe/handler.test.ts` (failing)**

The existing `matches a draft snapshot and appends a pending-diffs block` test already asserts the diff lands in `pending-diffs.md` (keep that). Add:

```ts
import { MATCHED_DRAFT_IDS_KEY } from '../_shared/learning-state.js';
// in the successful-match test:
expect(JSON.parse(ctx.__mem.__values.get(MATCHED_DRAFT_IDS_KEY)!)).toContain('draft-1');
```

Extend the existing `holds the watermark ... matched draft body cannot be fetched (F8)` test: assert the failed draft is NOT in the stored matched set (so it re-matches):

```ts
const matched = ctx.__mem.__values.get(MATCHED_DRAFT_IDS_KEY);
expect(matched ? JSON.parse(matched) : []).not.toContain('draft-1');
```

Add a pruning test: seed `MATCHED_DRAFT_IDS_KEY` with `['gone-draft','draft-1']`, provide a snapshot only for `draft-1`; after a run, stored set excludes `gone-draft`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `sent-observe/handler.ts`**

- Delete the `extractMatchedDraftIds` function. Add `MATCHED_DRAFT_IDS_KEY` to the `learning-state.js` import (already importing `readIdSet`/`writeIdSet` from Task 3).
- Replace the seed `const alreadyMatchedDraftIds = extractMatchedDraftIds(pendingDiffs.body);` with:

```ts
const seedMatchedDraftIds = await readIdSet(store, MATCHED_DRAFT_IDS_KEY);
const alreadyMatchedDraftIds = new Set(seedMatchedDraftIds); // mutable in-run guard for matchDraftToSent
```

- Track drafts that actually got a persisted diff this run. Near the other loop accumulators add `const newlyDiffedDraftIds = new Set<string>();`. In the draft-match success branch (right after `diffChunks.push(formatDiffBlock(draftMatch, sentBody)); draftMatches += 1;`) add `newlyDiffedDraftIds.add(draftMatch.draftId);`. (The fetch-failure branch already skips the push, so a failed draft is NOT added.)
- After the diffs append (`diffsPersisted`), write the pruned+augmented matched set, gated on `diffsPersisted`:

```ts
// Persist matched_draft_ids only when the diffs doc persisted. Include drafts whose diff actually
// landed this run (newlyDiffedDraftIds); EXCLUDE any whose body-fetch failed (never diffed) so
// they re-match next run — mirroring the old re-derive-from-pending-diffs behavior. Prune the
// carried-over set to drafts whose snapshot still exists (a snapshot TTL-sweeps after 7 idle days;
// once gone it can't be re-matched, so retaining its id is pointless).
if (diffsPersisted) {
  const snapshotIds = new Set(snapshots.map((s) => s.draftId));
  const nextMatched = new Set([...seedMatchedDraftIds].filter((id) => snapshotIds.has(id)));
  for (const id of newlyDiffedDraftIds) nextMatched.add(id);
  try {
    await writeIdSet(store, MATCHED_DRAFT_IDS_KEY, nextMatched);
  } catch (err) {
    ctx.log.warn({ err }, 'ceo-inbox-sent-observe: matched-guard write failed (diffs persisted; guard re-derives next run)');
  }
}
```

- The `pendingDiffs` `ensureDoc` read is still needed for the append; but its body is no longer scanned for guard ids. Keep the `ensureDoc(PENDING_DIFFS_PATH,...)` call.

- [ ] **Step 4: Run the test file**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/ceo-inbox-sent-observe/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

(Version bumps deferred to Task 8.)

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/ceo-inbox-sent-observe
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "refactor(sent-observe): matched-draft guard in config-store, excludes failed-fetch drafts (#1438)"
```

---

## Task 6: Delete dead parse/format machinery

All callers now use config JSON, so the markdown parsers/formatters and their tests are dead. Remove them and confirm nothing imports them.

**Files:**
- Modify: `skills/_shared/learning-digest.ts`, `skills/_shared/learning-digest.test.ts`
- Modify: `skills/_shared/task-completion-risk.ts`, `skills/_shared/task-completion-risk.test.ts`
- Modify: `skills/_shared/sent-observe-match.ts`, `skills/_shared/sent-observe-match.test.ts`

- [ ] **Step 1: Confirm no live importers of the doomed symbols**

Run (Grep tool, not shell): search the repo for each symbol and confirm only the definition + its own test remain:
`parseCompletionDigest`, `parseVoiceGuideProposal`, `pruneGuideProposals`, `removeCompletionBlock`, `parseCompletionCandidates`, `formatUndoNote`, `formatConfirmNote`, `formatCompletionCandidateBlock`.
Expected: no imports from any `handler.ts`.

- [ ] **Step 2: Remove from `learning-digest.ts`**

Delete `guideProposalBlocks`, `guideFromBlock`, `parseVoiceGuideProposal`, `parseCompletionDigest`, `pruneGuideProposals`, `removeCompletionBlock`, and the `VoiceGuideProposal` interface (now in `learning-state.ts`). Keep `renderVoiceGuideSection`, `renderCompletionSection`, and the `import type { CompletionDigestItem } from './learning-state.js';` added in Task 4.

- [ ] **Step 3: Remove from `task-completion-risk.ts`**

Delete `ParsedCompletionCandidate`, `parseCompletionCandidates`, `formatUndoNote`, `formatConfirmNote`. Keep `TaskRisk`, `CompletionAction`, `HIGH_PRIORITY_FLOOR`, `RiskTaskLike`, `classifyTaskRisk`, `decideCompletionAction`.

- [ ] **Step 4: Remove from `sent-observe-match.ts`**

Delete `formatCompletionCandidateBlock`. Keep everything else (`matchDraftToSent`, `matchTasksToSent`, `formatDiffBlock`, `trimEvidenceDoc`, `tokenize`, types).

- [ ] **Step 5: Trim the dead tests**

In `learning-digest.test.ts` delete the `parse*`/`prune*`/`removeCompletionBlock` cases; keep the `render*` cases. In `task-completion-risk.test.ts` delete the candidate parse/format cases; keep the `classifyTaskRisk`/`decideCompletionAction` cases. In `sent-observe-match.test.ts` delete the `formatCompletionCandidateBlock` case; keep `trimEvidenceDoc`/`formatDiffBlock`/match cases.

- [ ] **Step 6: Full test run + typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json test skills/`
Expected: PASS (no references to deleted symbols).
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add skills/_shared
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "refactor(learning): delete dead markdown parse/format machinery (#1438)"
```

---

## Task 7: Docs — ADR-029 + specs 04/13/19

**Files:**
- Modify: `docs/adr/029-passive-email-observation-and-counterfactual-competence.md`
- Modify: `docs/specs/19-tasks-and-backlog.md`, `docs/specs/13-office-identity.md`, `docs/specs/04-channels.md`

- [ ] **Step 1: ADR-029 store-mapping table**

Replace the single row `| Cadence / watermarks / guard markers | Scheduler crons + config-store |` (around L48) with two rows that separate cadence from the migrated machine-state, e.g.:

```
| Cadence / watermarks | Scheduler crons + `config-store` (`ceo_inbox`) |
| Queue / status / guard state (completion candidates, digest items, voice proposal, matched-draft & asked-task guards) | `config-store` JSON (`ceo_inbox`), one whole-rewritten key per store |
```

Add a sentence after the table noting the concurrency property: *"Machine-state keys use whole-object last-write-wins (no per-doc version check); acceptable because each key has effectively a single writer per cron tick and the queue key is keyed by task id so a held-watermark retry re-adds idempotently. Prose evidence (`pending-diffs.md`), snapshots, and shadow docs remain OKF."*

- [ ] **Step 2: Spec 19 (L346–347)**

Change the fuzzy-candidate guard sentence from the `completion_asked: {date}` doc-marker phrasing to config-store phrasing, e.g.: *"Fuzzy candidates are recorded in the `sent_observe.asked_task_ids` guard set (config-store, `ceo_inbox`) so they are not re-surfaced every run."*

- [ ] **Step 3: Spec 13 (L376–380)**

Change *"It queues a "## Guide Proposal" block (`status: pending`) in the digest"* to *"It records a single pending proposal object in `config-store` (`voice_learn.proposal`), surfaced in the digest."* Update the "Dismissed proposals get a guard marker and cooldown" line to reference the config cooldown key rather than a doc marker.

- [ ] **Step 4: Spec 04 (L100–101)**

Confirm the rolling OKF evidence doc (`pending-diffs.md`) description is still accurate (it is — diffs stay OKF). If L100 lists completion candidates as an OKF doc, adjust to say the completion-candidate *queue* is config-store while the `(draft, sent)` diffs remain OKF. (Verify exact wording against the file before editing.)

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add docs/adr docs/specs
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "docs(adr-029): machine state moved to config-store JSON; specs 04/13/19 updated (#1438)"
```

---

## Task 8: CHANGELOG + version bumps

**Files:**
- Modify: `CHANGELOG.md`, and the five touched `skill.json` files.

- [ ] **Step 1: Add an Unreleased entry**

Under `## [Unreleased]` → `### Changed` (create the section if absent), add one bullet (≤15 words after the dash; use a period, hard cap enforced):

```
- **Learning subsystem** — queue/status/guard state moved from OKF doc bodies to config-store JSON. (#1438)
```

- [ ] **Step 2: Bump each touched skill's version exactly once (patch)**

Per Joseph's standing rule, bump each `skill.json` **once per PR**, not per commit. Increment the patch component of `version` in each of:
`skills/voice-learn/skill.json`, `skills/list-learning-digest/skill.json`, `skills/resolve-learning-digest/skill.json`, `skills/ceo-inbox-sent-observe/skill.json`, `skills/task-completion-from-sent/skill.json`.

(A behavior-preserving storage refactor is a patch-level meaningful change — worth correlating prod behavior with a known config state, but no interface change.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json add CHANGELOG.md skills/voice-learn/skill.json skills/list-learning-digest/skill.json skills/resolve-learning-digest/skill.json skills/ceo-inbox-sent-observe/skill.json skills/task-completion-from-sent/skill.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-learning-state-json commit -s -m "chore: changelog + skill version bumps for learning-state migration (#1438)"
```

---

## Final verification (before PR)

- [ ] `pnpm -C <worktree> run typecheck` — clean.
- [ ] `pnpm -C <worktree> test skills/` — all learning-subsystem tests green.
- [ ] Grep confirms zero references to `PENDING_COMPLETIONS_PATH`, `PENDING_PROPOSALS_PATH`, `COMPLETION_DIGEST_PATH`, and the eight deleted parse/format symbols outside git history.
- [ ] Run the auto-review subagents (code-reviewer + silent-failure-hunter) per global CLAUDE.md before opening the PR; address high-priority findings.
- [ ] PR body includes `Closes #1438`.

## Self-review notes (coverage against the issue's acceptance criteria)

- *All queue/status/guard state in config JSON; no handler parses markdown bodies* → Tasks 2–6 (parsers deleted in 6).
- *Watermark-hold semantics preserved* → Task 3 (candidate-before-guard ordering + held-watermark test) and Task 5 (failed-fetch draft excluded).
- *Digest UX unchanged* → composers verbatim (Task 1 test), render helpers untouched, list/resolve round-trip tests (Tasks 2/4).
- *pending-diffs.md / snapshots / shadow docs unchanged* → only the guard *derivation* changed in Task 5; the doc format is untouched.
- *ADR-029 + specs updated; last-write-wins documented* → Task 7.
- *Unit tests: map-rewrite removal, supersede, guard persistence across held watermark* → Task 1 (removal, supersede), Task 3 (held-watermark guard), Tasks 3/5 (pruning).
