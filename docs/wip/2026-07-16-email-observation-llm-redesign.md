# Email-observation LLM redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two heuristic email-observation engines (voice learning, shadow decision comparison) with LLM assessment via `ctx.infraLlm`, reuse the shared `SensitivityClassifier`, include sensitive threads, and expose the skill manifest version to handlers.

**Architecture:** Voice learning becomes a free-form markdown `guide` on `WritingVoice`, maintained by a weekly batched `infraLlm.extract()` pass and approved via the daily digest. Shadow competence becomes an LLM judgment of substantive decision equivalence, run as one batched `extract()` call per sent-observe run, still writing binary `competence_flag` rows. Sensitivity checks route through the DI-injected `SensitivityClassifier`.

**Tech Stack:** TypeScript ESM (Node 24), Vitest, PostgreSQL, `ctx.infraLlm` (constrained LLM: `classify`/`extract`, errors-as-values), `SensitivityClassifier` (from `config/default.yaml` `sensitivity_rules`).

## Global Constraints

- ESM only; `.js` extensions on all relative imports; no `any`. (CLAUDE.md)
- Skills return `{ success: true, data }` / `{ success: false, error }` — never throw. (CLAUDE.md)
- Parameterized SQL only; no interpolation. (CLAUDE.md)
- `infraLlm` returns `{ ok: true, text } | { ok: false, error }` — errors as values, never thrown.
- Run `pnpm run typecheck` (all four tsconfig projects) before every commit touching `.ts`.
- Bump `skill.json` / agent `version` when a skill/agent changes; sign off commits with `-s` (DCO); no Co-Authored-By / Claude attribution.
- New capability field names in `execution.ts` MUST match `VALID_CAPABILITIES` in `src/skills/loader.ts`.
- Work happens in the existing worktree `worktrees/curia-email-obs` on branch `cursor/email-observation-learning-e945`. Run vitest via `npx vitest run <path>`; commands assume CWD is the worktree root.

---

### Task 1: Add `guide` to `WritingVoice` and render it

**Files:**
- Modify: `src/executive/types.ts` (WritingVoice interface)
- Modify: `src/executive/service.ts` (`validateProfile`, `compileWritingVoiceBlock`, `loadFromDb` defaulting)
- Test: `src/executive/service.test.ts` (or the nearest existing executive test)

**Interfaces:**
- Produces: `WritingVoice.guide: string` (markdown, `''` when unlearned); `compileWritingVoiceBlock` renders a "How the executive actually writes (learned…)" section when `guide` is non-empty.

- [ ] **Step 1: Write the failing test** — add to the executive service test file:

```ts
import { compileWritingVoiceBlock } from './service.js';
import type { ExecutiveProfile } from './types.js';

function baseProfile(guide: string): ExecutiveProfile {
  return {
    writingVoice: {
      tone: ['direct'], formality: 50, patterns: [],
      vocabulary: { prefer: [], avoid: [] }, signOff: 'Thanks', guide,
    },
  };
}

describe('compileWritingVoiceBlock guide', () => {
  it('renders the learned guide section when guide is non-empty', () => {
    const block = compileWritingVoiceBlock(baseProfile('Writes short. Dry humour. No greetings.'), 'Jordan');
    expect(block).toContain('How the executive actually writes');
    expect(block).toContain('Dry humour');
  });
  it('omits the guide section when guide is empty', () => {
    const block = compileWritingVoiceBlock(baseProfile(''), 'Jordan');
    expect(block).not.toContain('How the executive actually writes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/executive/service.test.ts -t "guide"`
Expected: FAIL — `guide` missing on the type / section not rendered.

- [ ] **Step 3: Add the field** — in `src/executive/types.ts`, add to `WritingVoice`:

```ts
  /** Email sign-off when drafting in the executive's voice. */
  signOff: string;
  /** Learned, free-form markdown describing how the executive actually writes.
   *  Maintained by the weekly voice-learn LLM pass; '' until first learned. */
  guide: string;
```

- [ ] **Step 4: Default + validate + render** — in `src/executive/service.ts`:
  - In `validateProfile`, after the existing checks, accept an optional guide:

```ts
  if (voice.guide !== undefined && typeof voice.guide !== 'string') {
    throw new Error('writingVoice.guide must be a string');
  }
```

  - In `loadFromDb` (where the profile object is assembled from the stored JSON, ~line 352), ensure `guide` defaults so pre-existing rows load:

```ts
      writingVoice: {
        // ...existing fields...
        guide: typeof raw.guide === 'string' ? raw.guide : '',
      },
```

  (Match the exact assembly already present; only add the `guide` line. If a config/file seed path also builds `writingVoice`, add `guide: '' ` there too so `initialize()` from `config/executive-profile.yaml` doesn't drop it.)
  - In `compileWritingVoiceBlock`, after the sign-off section and before the final `return lines.join('\n')`:

```ts
  // Learned voice guide (maintained by the weekly voice-learn LLM pass).
  if (voice.guide && voice.guide.trim()) {
    lines.push('**How the executive actually writes (learned from their edits):**');
    lines.push(voice.guide.trim());
    lines.push('');
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/executive/service.test.ts -t "guide"`
Expected: PASS. Then `npx vitest run src/executive/` to confirm no regressions (existing profile tests must still pass; if a fixture builds `WritingVoice` inline it needs `guide: ''`).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm run typecheck`
```bash
git add src/executive/types.ts src/executive/service.ts src/executive/service.test.ts
git commit -s -m "feat(executive): add learned free-form voice guide to WritingVoice"
```

---

### Task 2: Expose `skillVersion`/`skillName` on `SkillContext`; drop hardcoded consts

**Files:**
- Modify: `src/skills/types.ts` (SkillContext)
- Modify: `src/skills/execution.ts` (context assembly — near the `capabilityServices` map, ~1180-1330)
- Modify: `skills/ceo-inbox-draft-compose/handler.ts`, `skills/ceo-inbox-draft-edit/handler.ts`, `skills/ceo-inbox-draft-reply/handler.ts` (remove `SKILL_VERSION`, use `ctx.skillVersion`)
- Test: `src/skills/execution.test.ts` (or nearest execution-layer test)

**Interfaces:**
- Produces: `SkillContext.skillVersion: string`, `SkillContext.skillName: string`, populated from the loaded manifest.

- [ ] **Step 1: Write the failing test** — assert the executed handler receives `ctx.skillVersion` equal to the manifest version. Use the existing execution-layer test harness; add a minimal skill whose handler returns `ctx.skillVersion`, or assert via a spy that the injected context carries `skillVersion === manifest.version`. Concretely, in the execution test:

```ts
it('injects skillVersion and skillName from the manifest into ctx', async () => {
  // Arrange a registered skill with manifest.version '9.9.9' and a handler that
  // returns { success: true, data: { v: ctx.skillVersion, n: ctx.skillName } }.
  const result = await executionLayer.invoke('version-probe', {}, baseInvokeOpts);
  expect(result).toMatchObject({ success: true, data: { v: '9.9.9', n: 'version-probe' } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/skills/execution.test.ts -t "skillVersion"`
Expected: FAIL — `ctx.skillVersion` undefined.

- [ ] **Step 3: Add the fields to the type** — in `src/skills/types.ts` `SkillContext`, near the top field group:

```ts
  /** The invoking skill's manifest name and version (from skill.json). */
  skillName: string;
  skillVersion: string;
```

- [ ] **Step 4: Populate them at context build** — in `src/skills/execution.ts`, where the base context object is assembled (the object that later receives capability injection; `manifest` is in scope), add:

```ts
      skillName: manifest.name,
      skillVersion: manifest.version,
```

- [ ] **Step 5: Use `ctx.skillVersion` in the draft handlers** — in each of the three `ceo-inbox-draft-*` handlers:
  - Delete the `const SKILL_VERSION = '...'` line and its `/** Keep in sync… */` comment.
  - Change `agentVersion: SKILL_VERSION` to `agentVersion: ctx.skillVersion` in the `captureDraftSnapshot(...)` call.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/skills/execution.test.ts skills/ceo-inbox-draft-compose skills/ceo-inbox-draft-edit skills/ceo-inbox-draft-reply`
Expected: PASS (draft-handler tests that asserted the snapshot `agent_version` now see the manifest version — update those fixtures if they hardcoded `'0.3.0'` etc. to the manifest version used in the test ctx, or to `expect.any(String)`).
Run: `pnpm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/skills/types.ts src/skills/execution.ts skills/ceo-inbox-draft-compose/handler.ts skills/ceo-inbox-draft-edit/handler.ts skills/ceo-inbox-draft-reply/handler.ts src/skills/execution.test.ts
git commit -s -m "feat(skills): expose skillName/skillVersion on SkillContext; drop hardcoded consts"
```

---

### Task 3: Expose `SensitivityClassifier` to skills as a capability

**Files:**
- Modify: `src/skills/loader.ts` (`VALID_CAPABILITIES` set)
- Modify: `src/skills/types.ts` (`SkillContext.sensitivityClassifier`)
- Modify: `src/skills/execution.ts` (add field to `capabilityServices`; add `sensitivityClassifier` to the `ExecutionLayer` constructor deps)
- Modify: `src/index.ts` (pass the already-built `sensitivityClassifier` into `ExecutionLayer`)
- Test: `src/skills/loader.test.ts` (capability accepted) + execution injection test

**Interfaces:**
- Produces: `SkillContext.sensitivityClassifier?: SensitivityClassifier` (present when a skill declares the `sensitivityClassifier` capability). `SensitivityClassifier.classify(text: string, categoryHint?: string): Sensitivity`.

- [ ] **Step 1: Write the failing test** — in `loader.test.ts`, assert a manifest declaring `"capabilities": ["sensitivityClassifier"]` loads without error (today it should reject an unknown capability):

```ts
it('accepts the sensitivityClassifier capability', () => {
  expect(() => validateCapabilities(['sensitivityClassifier'])).not.toThrow();
});
```

(Use whatever the loader test already calls to validate capabilities.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/skills/loader.test.ts -t "sensitivityClassifier"`
Expected: FAIL — unknown capability.

- [ ] **Step 3: Register the capability** — in `src/skills/loader.ts`, add `'sensitivityClassifier'` to the `VALID_CAPABILITIES` set (alphabetically near the others).

- [ ] **Step 4: Wire the type + DI**
  - `src/skills/types.ts`: 
```ts
  /** Shared sensitivity classifier — available to skills declaring 'sensitivityClassifier'.
   *  Classifies free text against config sensitivity_rules. */
  sensitivityClassifier?: import('../memory/sensitivity.js').SensitivityClassifier;
```
  - `src/skills/execution.ts`: add `sensitivityClassifier: this.sensitivityClassifier,` to the `capabilityServices` map; add `private readonly sensitivityClassifier: SensitivityClassifier` (import the type) to the constructor deps.
  - `src/index.ts`: the `ExecutionLayer` is constructed after `sensitivityClassifier` already exists (built at ~line 534). Pass it into the `ExecutionLayer` constructor options.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/skills/loader.test.ts`
Expected: PASS.
Run: `pnpm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/skills/loader.ts src/skills/types.ts src/skills/execution.ts src/index.ts src/skills/loader.test.ts
git commit -s -m "feat(skills): expose SensitivityClassifier as a skill capability"
```

---

### Task 4: `task-completion-risk` uses the classifier

**Files:**
- Modify: `skills/_shared/task-completion-risk.ts` (`classifyTaskRisk` signature; remove `SENSITIVE_TAGS` + title regex)
- Modify: `skills/task-completion-from-sent/handler.ts` (pass `ctx.sensitivityClassifier`; declare capability)
- Modify: `skills/task-completion-from-sent/skill.json` (add `sensitivityClassifier` capability; bump version)
- Test: `skills/_shared/task-completion-risk.test.ts`

**Interfaces:**
- Consumes: `SkillContext.sensitivityClassifier` (Task 3).
- Produces: `classifyTaskRisk(task: RiskTaskLike, classify: (text: string) => Sensitivity): TaskRisk` — now takes a classify function (keeps the helper pure/testable).

- [ ] **Step 1: Rewrite the test** — replace the `SENSITIVE_TAGS`/title-regex cases in `task-completion-risk.test.ts`:

```ts
import { classifyTaskRisk, HIGH_PRIORITY_FLOOR } from './task-completion-risk.js';

// Fake classifier: 'restricted' when the text mentions "board", else 'internal'.
const fakeClassify = (text: string) =>
  /board|agm/i.test(text) ? ('restricted' as const) : ('internal' as const);

it('marks a restricted/confidential task high-risk via the classifier', () => {
  expect(classifyTaskRisk({ id: 't', title: 'Prep board pack', priority: 40, tags: [], progress: {} }, fakeClassify)).toBe('high');
});
it('marks an ordinary task low-risk', () => {
  expect(classifyTaskRisk({ id: 't', title: 'Follow up with John', priority: 40, tags: [], progress: {} }, fakeClassify)).toBe('low');
});
it('still marks high priority / plan / subtasks high-risk without the classifier firing', () => {
  expect(classifyTaskRisk({ id: 't', title: 'Call vendor', priority: HIGH_PRIORITY_FLOOR, tags: [], progress: {} }, () => 'internal')).toBe('high');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/_shared/task-completion-risk.test.ts`
Expected: FAIL — `classifyTaskRisk` arity/behaviour changed.

- [ ] **Step 3: Rewrite `classifyTaskRisk`** — in `task-completion-risk.ts`, remove `SENSITIVE_TAGS` and the `\b(agm|board|legal|investors?)\b` title regex; import the `Sensitivity` type and `isConfidentialOrAbove` from `../../src/memory/sensitivity.js`:

```ts
import { isConfidentialOrAbove, type Sensitivity } from '../../src/memory/sensitivity.js';

export function classifyTaskRisk(
  task: RiskTaskLike,
  classify: (text: string) => Sensitivity,
): TaskRisk {
  const plan = readPlanBlock(task.progress);
  if (plan) return 'high';
  if (task.hasSubtasks) return 'high';
  if (task.priority >= HIGH_PRIORITY_FLOOR) return 'high';
  const sensitivity = classify(`${task.title}\n${task.tags.join(' ')}`);
  if (isConfidentialOrAbove(sensitivity)) return 'high';
  return 'low';
}
```

- [ ] **Step 4: Update the handler** — in `task-completion-from-sent/handler.ts`, guard the capability and pass the classify function:

```ts
    if (!ctx.taskRepo || !ctx.workingDocs || !ctx.sensitivityClassifier) {
      return { success: false, error: 'task-completion-from-sent requires taskRepo, workingDocs, sensitivityClassifier' };
    }
    const classify = (text: string) => ctx.sensitivityClassifier!.classify(text);
    // ...
    const risk = classifyTaskRisk({ id: task.id, title: task.title, priority: task.priority, tags: task.tags, progress: task.progress, hasSubtasks }, classify);
```

- [ ] **Step 5: Manifest** — `skills/task-completion-from-sent/skill.json`: add `"sensitivityClassifier"` to `capabilities`; bump `version` `0.1.1` → `0.2.0` (new capability).

- [ ] **Step 6: Update the handler test** — `task-completion-from-sent/handler.test.ts` `makeCtx` must supply `sensitivityClassifier: { classify: () => 'internal' }` and, for the AGM case, a classify that returns `'restricted'` for board/agm text so the existing "confirms high-risk AGM" assertion holds.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run skills/_shared/task-completion-risk.test.ts skills/task-completion-from-sent`
Expected: PASS.
Run: `pnpm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add skills/_shared/task-completion-risk.ts skills/_shared/task-completion-risk.test.ts skills/task-completion-from-sent/
git commit -s -m "feat(task-completion): classify risk via shared SensitivityClassifier"
```

---

### Task 5: Slim `shadow-draft.ts` — remove exclusion + heuristic scorer; add batched judge

**Files:**
- Modify: `skills/_shared/shadow-draft.ts` (delete `SENSITIVE_RE`, `isHighSensitivityThread`, `scoreDecisionEquivalence`, `detectDecisionPolarity`; add `buildShadowJudgePrompt` + `parseShadowJudgeResult`)
- Modify: `skills/ceo-inbox-shadow-draft/handler.ts` (remove the high-sensitivity skip branch)
- Modify: `skills/ceo-inbox-shadow-draft/skill.json` (drop unused `from`/`labels` inputs if only used for exclusion; bump version)
- Test: `skills/_shared/shadow-draft.test.ts`, `skills/ceo-inbox-shadow-draft/handler.test.ts`

**Interfaces:**
- Produces:
  - `buildShadowJudgePrompt(pairs: ShadowJudgePair[]): string` where `ShadowJudgePair = { sourceMessageId: string; subject: string; shadowBody: string; sentBody: string }`.
  - `parseShadowJudgeResult(text: string): ShadowJudgement[]` where `ShadowJudgement = { sourceMessageId: string; sameDecision: boolean; reason: string }` (tolerant JSON parse; ignores malformed/missing entries).
- Removed: `isHighSensitivityThread`, `scoreDecisionEquivalence`, `detectDecisionPolarity`, `SHADOW*` sensitivity regex.

- [ ] **Step 1: Rewrite the test** — replace the polarity/equivalence tests with prompt + parse tests:

```ts
import { buildShadowJudgePrompt, parseShadowJudgeResult } from './shadow-draft.js';

describe('buildShadowJudgePrompt', () => {
  it('includes each pair id and both bodies and asks for substantive equivalence', () => {
    const p = buildShadowJudgePrompt([
      { sourceMessageId: 'm1', subject: 'Re: meeting', shadowBody: 'Thursday 3pm works.', sentBody: 'Let us do Thursday at 3.' },
    ]);
    expect(p).toContain('m1');
    expect(p).toContain('Thursday 3pm works.');
    expect(p).toMatch(/decision|recommendation|outcome/i);
    expect(p).toMatch(/same_decision/);
  });
});

describe('parseShadowJudgeResult', () => {
  it('parses a JSON array of judgements', () => {
    const out = parseShadowJudgeResult('[{"source_message_id":"m1","same_decision":true,"reason":"both confirm Thursday"}]');
    expect(out).toEqual([{ sourceMessageId: 'm1', sameDecision: true, reason: 'both confirm Thursday' }]);
  });
  it('tolerates surrounding prose and skips malformed entries', () => {
    const out = parseShadowJudgeResult('Here you go:\n[{"source_message_id":"m2","same_decision":false,"reason":"diverged"},{"bad":1}]\ndone');
    expect(out).toEqual([{ sourceMessageId: 'm2', sameDecision: false, reason: 'diverged' }]);
  });
  it('returns [] on unparseable text', () => {
    expect(parseShadowJudgeResult('no json here')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/_shared/shadow-draft.test.ts`
Expected: FAIL — new functions not defined.

- [ ] **Step 3: Implement** — in `shadow-draft.ts`, delete `SENSITIVE_RE`, `isHighSensitivityThread`, `scoreDecisionEquivalence`, `detectDecisionPolarity`, `DecisionPolarity`, `DENY_RE`, `AFFIRM_RE`, and the now-unused `tokenize` import if nothing else uses it. Keep `SHADOW_DOC_TYPE`, `SHADOW_SCRATCH_PREFIX`, `shadowDraftPath`, `ShadowSnapshot`, `parseShadowDoc`. Add:

```ts
export interface ShadowJudgePair {
  sourceMessageId: string;
  subject: string;
  shadowBody: string;
  sentBody: string;
}

export interface ShadowJudgement {
  sourceMessageId: string;
  sameDecision: boolean;
  reason: string;
}

/** Build one prompt that judges substantive decision equivalence for a batch of pairs. */
export function buildShadowJudgePrompt(pairs: ShadowJudgePair[]): string {
  const items = pairs
    .map(
      (p, i) =>
        `### Pair ${i + 1} (source_message_id: ${p.sourceMessageId})\n` +
        `Subject: ${p.subject}\n\n` +
        `SHADOW (what the assistant would have sent):\n${p.shadowBody.trim() || '(empty)'}\n\n` +
        `ACTUAL (what the CEO actually sent):\n${p.sentBody.trim() || '(empty)'}`,
    )
    .join('\n\n---\n\n');
  return [
    'You are auditing an AI assistant against a CEO. For each pair, decide whether the',
    'SHADOW email reaches the SAME substantive decision / recommendation / outcome as the',
    'ACTUAL email — e.g. proposes the same meeting time, gives the same answer to a policy',
    'question, makes the same ask, reports the same status. Judge the decision, NOT wording,',
    'tone, or length. Opposing or materially different decisions are not the same.',
    '',
    'Return ONLY a JSON array, one object per pair:',
    '[{"source_message_id": "...", "same_decision": true|false, "reason": "<short>"}]',
    '',
    items,
  ].join('\n');
}

/** Tolerant parse of the judge output — extracts the first JSON array, keeps well-formed entries. */
export function parseShadowJudgeResult(text: string): ShadowJudgement[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ShadowJudgement[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.source_message_id !== 'string' || typeof r.same_decision !== 'boolean') continue;
    out.push({
      sourceMessageId: r.source_message_id,
      sameDecision: r.same_decision,
      reason: typeof r.reason === 'string' ? r.reason : '',
    });
  }
  return out;
}
```

- [ ] **Step 4: Remove the exclusion from the handler** — in `ceo-inbox-shadow-draft/handler.ts`, delete the `isHighSensitivityThread(...)` import and the whole `if (isHighSensitivityThread(...)) { … return { captured:false, skipped_reason:'high_sensitivity' } }` branch. Keep the rest (dedup on existing doc, create the shadow doc). Remove now-unused `from`/`labels` parsing if only the exclusion used them.

- [ ] **Step 5: Manifest** — `ceo-inbox-shadow-draft/skill.json`: if `from`/`labels` inputs are no longer used, remove them from `inputs`; bump `version` `0.1.1` → `0.2.0`.

- [ ] **Step 6: Update the handler test** — in `ceo-inbox-shadow-draft/handler.test.ts`, delete the "skips high-sensitivity threads" test; add one proving a board-subject thread IS now captured:

```ts
it('captures a board-subject thread (no sensitivity exclusion)', async () => {
  const create = vi.fn().mockResolvedValue({});
  const ctx = { input: { source_message_id: 'm9', subject: 'Board pack for Friday', body: 'Draft reply.' },
    agentId: 'ceo-inbox', workingDocs: { read: vi.fn().mockResolvedValue(null), create },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as SkillContext;
  const result = await new CeoInboxShadowDraftHandler().execute(ctx);
  expect((result as { data: { captured: boolean } }).data.captured).toBe(true);
  expect(create).toHaveBeenCalled();
});
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run skills/_shared/shadow-draft.test.ts skills/ceo-inbox-shadow-draft`
Expected: PASS.
Run: `pnpm run typecheck`

- [ ] **Step 8: Commit**

```bash
git add skills/_shared/shadow-draft.ts skills/_shared/shadow-draft.test.ts skills/ceo-inbox-shadow-draft/
git commit -s -m "feat(shadow-draft): drop sensitivity exclusion + heuristic scorer; add batched LLM judge"
```

---

### Task 6: `ceo-inbox-sent-observe` reconciles via the batched LLM judge

**Files:**
- Modify: `skills/ceo-inbox-sent-observe/handler.ts` (collect pairs; one batched `extract`; parse; write rows)
- Modify: `skills/ceo-inbox-sent-observe/skill.json` (add `infraLlm` capability; bump version)
- Test: `skills/ceo-inbox-sent-observe/handler.test.ts`

**Interfaces:**
- Consumes: `buildShadowJudgePrompt`, `parseShadowJudgeResult` (Task 5); `ctx.infraLlm.extract`.

- [ ] **Step 1: Write the failing test** — extend the sent-observe test: a shadow doc matches a sent message; mock `ctx.infraLlm.extract` to return a JSON judgement; assert an `actionLogRepo.insert` row with `competenceFlag` from the LLM and the shadow doc marked `reconciled_at`.

```ts
it('reconciles shadow drafts via a batched LLM judge', async () => {
  // sent message msg-sent-1 on thread-1; shadow doc for source msg 'src-1' on thread-1.
  // ctx.infraLlm.extract resolves { ok: true, text: '[{"source_message_id":"src-1","same_decision":true,"reason":"same"}]' }
  // Assert ctx.__actionLog has one row: competenceFlag 1, scoredBy 'shadow-reconciler', skillName 'shadow-draft-eval'.
});
```

(Extend `buildCtx` to provide `infraLlm: { extract: vi.fn(), classify: vi.fn() }` and an `actionLogRepo: { insert: vi.fn(async r => { actionLog.push(r); return 1; }) }` capturing rows, plus a shadow doc via `listByPrefix(SHADOW_SCRATCH_PREFIX)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/ceo-inbox-sent-observe/handler.test.ts -t "batched LLM judge"`
Expected: FAIL — no batched judge path.

- [ ] **Step 3: Refactor the reconcile loop** — in `runObserve`:
  - In the per-message loop, when a `shadow` matches (existing find), DON'T score inline. Instead push a `ShadowJudgePair` into a `judgePairs: ShadowJudgePair[]` array (fetch the sent body once as today; use shadow.subject/msg.subject) and record the shadow for post-loop marking. Keep the run-local `claimedShadows` guard.
  - After the message loop, if `judgePairs.length > 0 && ctx.infraLlm && ctx.actionLogRepo`:

```ts
    const BATCH = 20;
    for (let i = 0; i < judgePairs.length; i += BATCH) {
      const batch = judgePairs.slice(i, i + BATCH);
      const res = await ctx.infraLlm.extract(buildShadowJudgePrompt(batch), { maxTokens: 1500 });
      if (!res.ok) {
        ctx.log.warn({ error: res.error, count: batch.length }, 'sent-observe: shadow judge LLM failed — leaving unreconciled');
        continue; // reconciled_at stays unset → retried next run
      }
      const judgements = parseShadowJudgeResult(res.text);
      for (const j of judgements) {
        const pair = batch.find((p) => p.sourceMessageId === j.sourceMessageId);
        if (!pair) continue;
        try {
          await ctx.actionLogRepo.insert({
            taskId: ctx.taskEventId ?? `shadow:${j.sourceMessageId}`,
            conversationId: ctx.conversationId,
            skillName: 'shadow-draft-eval',
            actionRisk: 'none',
            outcome: 'shadow_evaluated',
            taskSummary: `Shadow vs sent (${j.sourceMessageId}): ${j.reason}`,
            payload: { shadow: true, source_message_id: j.sourceMessageId, competence_reason: j.reason },
            competenceFlag: j.sameDecision ? 1 : 0,
            commitmentFlag: null,
            compatibility: null,
            scoredBy: 'shadow-reconciler',
          });
          shadowReconciled += 1;
          const path = `${SHADOW_SCRATCH_PREFIX}/${j.sourceMessageId}.md`;
          const doc = await ctx.workingDocs.read(path);
          if (doc) {
            await ctx.workingDocs.update(path, {
              frontmatter: { ...doc.frontmatter, reconciled_at: new Date().toISOString(), competence_flag: j.sameDecision ? 1 : 0 },
              expectedVersion: doc.version,
            });
          }
        } catch (err) {
          ctx.log.error({ err, sourceMessageId: j.sourceMessageId }, 'sent-observe: shadow competence insert failed');
        }
      }
    }
```

  - Delete the old inline `scoreDecisionEquivalence` block and its import.

- [ ] **Step 4: Manifest** — `ceo-inbox-sent-observe/skill.json`: add `"infraLlm"` to `capabilities`; bump `version` `0.1.2` → `0.2.0`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run skills/ceo-inbox-sent-observe`
Expected: PASS (existing watermark/pagination/task-candidate tests unaffected; the shadow test uses the mocked LLM).
Run: `pnpm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add skills/ceo-inbox-sent-observe/
git commit -s -m "feat(sent-observe): reconcile shadow competence via batched LLM judge"
```

---

### Task 7: Slim `voice-learn-logic.ts` — delete heuristics, keep parse, add prompt builder

**Files:**
- Modify: `skills/_shared/voice-learn-logic.ts`
- Test: `skills/_shared/voice-learn-logic.test.ts`

**Interfaces:**
- Keeps: `parsePendingDiffs(body): ParsedDiffPair[]`, `ParsedDiffPair`.
- Produces: `buildVoiceGuidePrompt(currentGuide: string, pairs: ParsedDiffPair[]): string`.
- Removes: `proposeDeltasFromPairs`, `decideApplication`, `THRESHOLDS`, `extractSignOff`, `extractVocabularySignals`, `meanLengthDelta`, `formatProposalBlock`, `isNearDefaultProfile`, provenance types, `VoiceDelta`/`ApplyDecision`.

- [ ] **Step 1: Rewrite the test** — keep the `parsePendingDiffs` tests (verbatim / `---` / unrelated-rewrite). Delete the delta/threshold/decideApplication/cold-start tests. Add:

```ts
import { buildVoiceGuidePrompt, parsePendingDiffs } from './voice-learn-logic.js';

describe('buildVoiceGuidePrompt', () => {
  it('includes the current guide and the draft/sent pairs and asks for an updated guide', () => {
    const pairs = parsePendingDiffs(SAMPLE_DIFFS);
    const prompt = buildVoiceGuidePrompt('Existing guide: writes short.', pairs);
    expect(prompt).toContain('Existing guide: writes short.');
    expect(prompt).toContain('Best regards'); // from a draft body
    expect(prompt).toMatch(/how the (ceo|executive) writes/i);
  });
  it('handles an empty current guide', () => {
    expect(buildVoiceGuidePrompt('', parsePendingDiffs(SAMPLE_DIFFS))).toMatch(/how the (ceo|executive) writes/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/_shared/voice-learn-logic.test.ts`
Expected: FAIL — deleted symbols still imported / `buildVoiceGuidePrompt` missing.

- [ ] **Step 3: Implement** — delete the heuristic exports listed above and their helpers (`wordSet`, `normalizeWs` stays only if still used by `isVerbatim`/`isNearTotalRewrite`; keep those two since `parsePendingDiffs` uses them). Add:

```ts
export function buildVoiceGuidePrompt(currentGuide: string, pairs: ParsedDiffPair[]): string {
  const diffs = pairs
    .map(
      (p, i) =>
        `### Edit ${i + 1}\nDRAFT (assistant wrote):\n${p.draftBody.trim()}\n\nSENT (CEO actually sent):\n${p.sentBody.trim()}`,
    )
    .join('\n\n---\n\n');
  return [
    'You maintain a short guide describing how a specific CEO writes email, used to steer an',
    'assistant that drafts on their behalf. Below are recent cases where the assistant drafted',
    'and the CEO edited before sending. Infer how the CEO writes — tone, directness, humour,',
    'greetings/sign-off, formatting, structure, length, phrasing they add or cut.',
    '',
    'Current guide (may be empty):',
    currentGuide.trim() || '(none yet)',
    '',
    'Return an UPDATED guide as concise markdown bullet guidance (no preamble). Fold in the new',
    'evidence; keep still-valid points; drop nothing without reason. Focus on durable, general',
    'patterns, not one-off wording.',
    '',
    '## Recent edits',
    diffs,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run skills/_shared/voice-learn-logic.test.ts`
Expected: PASS.
Run: `pnpm run typecheck` (will surface consumers of deleted symbols — fixed in Task 8/9.)
Note: typecheck WILL fail here on `voice-learn/handler.ts` and `resolve-learning-digest` until Tasks 8-9 land. That's expected; commit this task's files only and proceed — do NOT "fix" consumers here.

- [ ] **Step 5: Commit**

```bash
git add skills/_shared/voice-learn-logic.ts skills/_shared/voice-learn-logic.test.ts
git commit -s -m "refactor(voice-learn-logic): drop heuristics; add LLM guide prompt builder"
```

---

### Task 8: `voice-learn` weekly LLM pass → propose guide to the digest

**Files:**
- Modify: `skills/voice-learn/handler.ts` (replace heuristic loop with one `extract`; propose whole-guide)
- Modify: `skills/voice-learn/skill.json` (add `infraLlm` capability; bump version)
- Test: `skills/voice-learn/handler.test.ts`

**Interfaces:**
- Consumes: `buildVoiceGuidePrompt`, `parsePendingDiffs` (Task 7); `ctx.infraLlm.extract`; `executiveProfileService.get().writingVoice.guide`.
- Produces: `PENDING_PROPOSALS_PATH` (unchanged path) now holds a single guide proposal block; exports `CONFIG_NAMESPACE`, `PENDING_PROPOSALS_PATH`, `PENDING_PROPOSALS_TYPE`, `DISMISSED_KEY` (kept for cooldown). Guide-proposal block format (consumed by Task 9):

```
## Guide Proposal
- status: pending
- generated_at: <iso>

<guide markdown>
```

- [ ] **Step 1: Write the failing test** — rewrite `voice-learn/handler.test.ts`:

```ts
it('proposes an updated guide from the diff corpus via the LLM', async () => {
  const ctx = makeCtx({}); // provides infraLlm.extract → { ok:true, text: 'Writes short. Dry humour.' }
  (ctx.infraLlm.extract as any).mockResolvedValue({ ok: true, text: '- Writes short.\n- Dry humour.' });
  const result = await handler.execute(ctx);
  expect(result.success).toBe(true);
  const proposals = ctx.__docs.get(PENDING_PROPOSALS_PATH)?.body ?? '';
  expect(proposals).toContain('## Guide Proposal');
  expect(proposals).toContain('Dry humour');
  // profile NOT written directly (human-in-the-loop)
  expect(ctx.__updates).toHaveLength(0);
});

it('no pairs → no LLM call, no proposal', async () => {
  const ctx = makeCtx({ diffs: '# empty\n' });
  const result = await handler.execute(ctx);
  expect(result.success).toBe(true);
  expect((ctx.infraLlm.extract as any)).not.toHaveBeenCalled();
});

it('LLM failure → no proposal, success result', async () => {
  const ctx = makeCtx({});
  (ctx.infraLlm.extract as any).mockResolvedValue({ ok: false, error: 'timeout' });
  const result = await handler.execute(ctx);
  expect(result.success).toBe(true);
  expect(ctx.__docs.get(PENDING_PROPOSALS_PATH)).toBeUndefined();
});
```

(Extend `makeCtx` to add `infraLlm: { extract: vi.fn(), classify: vi.fn() }`; profile `get()` returns `writingVoice` with `guide: ''`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/voice-learn/handler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `runLearn`** — replace the delta loop and provenance/dismissed/bootstrap machinery with:

```ts
    if (!ctx.executiveProfileService || !ctx.workingDocs || !ctx.infraLlm) {
      return { success: false, error: 'voice-learn requires executiveProfileService, workingDocs, infraLlm' };
    }
    const diffsDoc = await ctx.workingDocs.read(PENDING_DIFFS_PATH);
    const pairs = parsePendingDiffs(diffsDoc?.body ?? '');
    if (pairs.length === 0) {
      return { success: true, data: { pairs_considered: 0, proposed: false } };
    }
    // Dedup: skip if a guide proposal is already pending.
    const existing = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
    if (existing && /## Guide Proposal[\s\S]*?- status:\s*pending/.test(existing.body)) {
      return { success: true, data: { pairs_considered: pairs.length, proposed: false, reason: 'proposal-pending' } };
    }
    const currentGuide = ctx.executiveProfileService.get().writingVoice.guide ?? '';
    const MAX_PAIRS = 40;
    const batch = pairs.slice(-MAX_PAIRS);
    const res = await ctx.infraLlm.extract(buildVoiceGuidePrompt(currentGuide, batch), { maxTokens: 1200 });
    if (!res.ok) {
      ctx.log.warn({ error: res.error }, 'voice-learn: LLM failed — no proposal this run');
      return { success: true, data: { pairs_considered: pairs.length, proposed: false, reason: 'llm-failed' } };
    }
    const guide = res.text.trim();
    if (!guide) {
      return { success: true, data: { pairs_considered: pairs.length, proposed: false, reason: 'empty-guide' } };
    }
    const block = `## Guide Proposal\n- status: pending\n- generated_at: ${new Date().toISOString()}\n\n${guide}\n\n---\n`;
    if (!existing) {
      await ctx.workingDocs.create({ path: PENDING_PROPOSALS_PATH, type: PENDING_PROPOSALS_TYPE, frontmatter: { title: 'Pending voice guide proposal' }, body: `# Pending voice guide proposal\n\n${block}`, agentId: ctx.agentId });
    } else {
      await ctx.workingDocs.append(PENDING_PROPOSALS_PATH, { content: block, expectedVersion: existing.version });
    }
    return { success: true, data: { pairs_considered: pairs.length, proposed: true } };
```

  Remove the now-dead imports (`decideApplication`, `formatProposalBlock`, `isNearDefaultProfile`, provenance helpers, `blockedProposalFields`, `patchIsNoop`, `parseProvenance`, `parseDismissed`, `ConfigStore` if unused). Keep exporting `PENDING_PROPOSALS_PATH`, `PENDING_PROPOSALS_TYPE`, `CONFIG_NAMESPACE`, `DISMISSED_KEY`.

- [ ] **Step 4: Manifest** — `skills/voice-learn/skill.json`: add `"infraLlm"` to capabilities; drop `entityMemory` if no longer used; bump `version` `0.1.2` → `0.2.0`. Update `outputs` to `{ pairs_considered, proposed }`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run skills/voice-learn/handler.test.ts`
Expected: PASS.
Run: `pnpm run typecheck` (still red on resolve-learning-digest until Task 9).

- [ ] **Step 6: Commit**

```bash
git add skills/voice-learn/
git commit -s -m "feat(voice-learn): weekly LLM pass proposes a free-form voice guide"
```

---

### Task 9: whole-guide digest helpers + resolve-learning-digest

**Files:**
- Modify: `skills/_shared/learning-digest.ts` (replace per-field voice helpers with guide helpers)
- Modify: `skills/list-learning-digest/handler.ts` (use guide renderer)
- Modify: `skills/resolve-learning-digest/handler.ts` (approve/dismiss the guide, not a field)
- Modify: `skills/resolve-learning-digest/skill.json` + `skills/list-learning-digest/skill.json` (bump versions)
- Test: `skills/_shared/learning-digest.test.ts`, `skills/list-learning-digest/handler.test.ts`, `skills/resolve-learning-digest/handler.test.ts`

**Interfaces:**
- Produces:
  - `parseVoiceGuideProposal(body): { status: string; guide: string } | null` (returns the pending guide, else null).
  - `renderVoiceGuideSection(guide: string | null): string` (digest section; `''` when null).
  - `markGuideProposalStatus(body, status): string`.
  - Completion helpers (`parseCompletionDigest`, `renderCompletionSection`, `markCompletionStatus`) unchanged.
- `resolve-learning-digest` `approve_voice` now takes no `field`; writes `{ writingVoice: { ...current, guide } }` and marks the proposal `approved`. `dismiss_voice` marks `dismissed` (+ existing cooldown marker).

- [ ] **Step 1: Rewrite the tests** — in `learning-digest.test.ts`, replace the per-field proposal cases with guide cases:

```ts
import { parseVoiceGuideProposal, renderVoiceGuideSection, markGuideProposalStatus } from './learning-digest.js';

const GUIDE_DOC = `# Pending voice guide proposal\n\n## Guide Proposal\n- status: pending\n- generated_at: 2026-07-16T00:00:00.000Z\n\n- Writes short.\n- Dry humour.\n\n---\n`;

it('parses a pending guide proposal', () => {
  expect(parseVoiceGuideProposal(GUIDE_DOC)?.guide).toContain('Dry humour');
});
it('renders the guide section only when present', () => {
  expect(renderVoiceGuideSection(null)).toBe('');
  expect(renderVoiceGuideSection('- Writes short.')).toContain('### Proposed writing-voice update');
});
it('marks the guide proposal status', () => {
  expect(markGuideProposalStatus(GUIDE_DOC, 'approved')).toContain('status: approved');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run skills/_shared/learning-digest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the guide helpers** — in `learning-digest.ts`, remove `VoiceProposalItem`, `parseVoiceProposals`, `renderVoiceProposalsSection`, `markProposalStatus`. Add:

```ts
export interface VoiceGuideProposal { status: string; guide: string; }

export function parseVoiceGuideProposal(body: string): VoiceGuideProposal | null {
  const idx = body.indexOf('## Guide Proposal');
  if (idx < 0) return null;
  const section = body.slice(idx);
  const status = (section.match(/- status:\s*(\S+)/)?.[1] ?? 'pending').trim();
  if (status !== 'pending') return null;
  // Guide is everything after the blank line following the metadata, up to the trailing '---'.
  const afterMeta = section.replace(/^## Guide Proposal[\s\S]*?\n\n/, '');
  const guide = afterMeta.split(/\n---\s*$/m)[0]!.trim();
  return { status, guide };
}

export function renderVoiceGuideSection(guide: string | null): string {
  if (!guide) return '';
  return ['### Proposed writing-voice update', '', guide, '', 'Reply `approve voice` or `dismiss voice`.', ''].join('\n');
}

export function markGuideProposalStatus(body: string, status: string): string {
  return body.replace(/(## Guide Proposal[\s\S]*?- status:\s*)\S+/, `$1${status}`);
}
```

- [ ] **Step 4: Update `list-learning-digest`** — swap `parseVoiceProposals`/`renderVoiceProposalsSection` for `parseVoiceGuideProposal`/`renderVoiceGuideSection`:

```ts
      const guide = parseVoiceGuideProposal(proposalsDoc?.body ?? '');
      const completion_items = parseCompletionDigest(completionsDoc?.body ?? '');
      const sections = [renderVoiceGuideSection(guide?.guide ?? null), renderCompletionSection(completion_items)].filter(Boolean).join('\n');
      return { success: true, data: { voice_guide: guide?.guide ?? null, completion_items, sections_markdown: sections,
        message: !guide && completion_items.length === 0 ? 'No pending learning-digest items.' : undefined } };
```

- [ ] **Step 5: Update `resolve-learning-digest`** — the `approve_voice`/`dismiss_voice` branch no longer needs `field`:

```ts
    if (action === 'approve_voice' || action === 'dismiss_voice') {
      const doc = await ctx.workingDocs.read(PENDING_PROPOSALS_PATH);
      const proposal = doc ? parseVoiceGuideProposal(doc.body) : null;
      if (!doc || !proposal) return { success: false, error: 'No pending voice guide proposal' };
      if (action === 'approve_voice') {
        const current = ctx.executiveProfileService.get().writingVoice;
        await ctx.executiveProfileService.update({ writingVoice: { ...current, guide: proposal.guide } }, 'skill', 'voice guide approved');
        await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, { body: markGuideProposalStatus(doc.body, 'approved'), expectedVersion: doc.version });
        return { success: true, data: { resolved: true, detail: 'Approved voice guide' } };
      }
      // dismiss: keep the existing DISMISSED_KEY cooldown write, then:
      await ctx.workingDocs.update(PENDING_PROPOSALS_PATH, { body: markGuideProposalStatus(doc.body, 'dismissed'), expectedVersion: doc.version });
      return { success: true, data: { resolved: true, detail: 'Dismissed voice guide' } };
    }
```

  Remove the now-unused `PROVENANCE_KEY`/provenance imports and the per-field `findProposal`. Keep the completion-action branch and the matching-item guard from #1429.

- [ ] **Step 6: Update the two handler tests** — `list-learning-digest/handler.test.ts` and `resolve-learning-digest/handler.test.ts`: replace per-field proposal bodies with the `## Guide Proposal` body; the resolve approve test asserts `executiveProfileService.update` called with `writingVoice.guide` = the proposed guide and the doc marked `approved`.

- [ ] **Step 7: Manifests** — bump `resolve-learning-digest` `0.1.1` → `0.2.0` (input `field` removed for voice actions) and `list-learning-digest` `0.1.1` → `0.2.0` (output shape `voice_guide`). Update their `inputs`/`outputs` docs. Remove `field` from resolve's voice-action input description.

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run skills/_shared/learning-digest.test.ts skills/list-learning-digest skills/resolve-learning-digest skills/voice-learn`
Expected: PASS.
Run: `pnpm run typecheck`
Expected: CLEAN now (all consumers of the deleted Task-7/8 symbols updated).

- [ ] **Step 9: Commit**

```bash
git add skills/_shared/learning-digest.ts skills/_shared/learning-digest.test.ts skills/list-learning-digest/ skills/resolve-learning-digest/
git commit -s -m "feat(digest): whole-guide voice proposal + approve/dismiss"
```

---

### Task 10: Agent YAML — version, autonomy-line tidy, shadow-skip line

**Files:**
- Modify: `agents/ceo-inbox.yaml`
- Test: none (config); validated by `pnpm run typecheck` + agent-load tests if present.

- [ ] **Step 1: Version** — `version: "0.18.1"` → `version: "0.14.0"`.

- [ ] **Step 2: Autonomy-band line** — replace:

```
  **Autonomy band:** when an Autonomy block is injected into your prompt, let
  higher bands shift triage toward drafting/handling and lower bands toward
  punting (Seen/Urgent/Stuck). Never write or adjust the global autonomy score
  yourself — only the Phase 3 scoring pass does that.
```

with:

```
  **Autonomy band:** when an Autonomy block is present in your prompt, let a
  higher band shift your triage toward drafting and handling, and a lower band
  toward punting (Seen / Urgent / Stuck).
```

- [ ] **Step 3: Shadow-drafting line** — the shadow-drafting instruction currently ends "…Skip board/investor/legal/spouse threads." Remove that sentence (sensitive threads are now included). The line becomes:

```
  **Shadow drafting (during triage only):** when you classify a message as 📌 Seen,
  🚨 Urgent, or ⚠️ Stuck (a punt), also call `ceo-inbox-shadow-draft` with the
  message id, subject, recipients, disposition, and the reply you *would* have
  drafted. Never show or send that draft.
```

- [ ] **Step 4: Verify + commit**

Run: `pnpm run typecheck` (and `npx vitest run tests/unit -t "ceo-inbox"` if agent-config tests exist)
```bash
git add agents/ceo-inbox.yaml
git commit -s -m "chore(ceo-inbox): version 0.14.0; tidy autonomy line; include sensitive threads in shadow drafting"
```

---

### Task 11: Docs — edit ADR-029 in place; update specs 04/13/14

**Files:**
- Modify: `docs/adr/029-passive-email-observation-and-counterfactual-competence.md`
- Modify: `docs/specs/13-office-identity.md`, `docs/specs/14-autonomy-engine.md`, `docs/specs/04-channels.md`

- [ ] **Step 1: ADR-029** — in the Decision + Consequences:
  - Counterfactual competence: change "score from ground truth (the actual send), not the generic LLM judge" and the deterministic `scoreDecisionEquivalence` description to: competence is judged by a **batched LLM** assessment of substantive decision/recommendation equivalence; `competence_flag` remains 0/1; `scored_by = 'shadow-reconciler'`.
  - Voice mapping row: change "Learned voice → `ExecutiveProfile.WritingVoice` structured fields" to "Learned voice → free-form `WritingVoice.guide`, maintained by a weekly batched LLM pass and approved via the digest."
  - Consequences: reverse the "High-sensitivity threads … excluded from shadow capture" bullet to "sensitive threads ARE included (highest-stakes decisions); widened privacy surface, retention per OKF scratch conventions."

- [ ] **Step 2: Spec 13** — replace the "Observation → learn loop" heuristic description + threshold table with: weekly `voice-learn` batched LLM pass produces an updated free-form guide, proposed in the digest, approved via `resolve-learning-digest`. Note the guide renders through `compileWritingVoiceBlock`.

- [ ] **Step 3: Spec 14** — replace the shadow-draft competence token/number/commit heuristic paragraph with the batched LLM decision-equivalence judgment (binary `competence_flag`, feeds Phase 3 unchanged; sensitive threads included).

- [ ] **Step 4: Spec 04** — one-line note: voice learning uses an LLM extraction pass over draft→sent diffs.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/029-passive-email-observation-and-counterfactual-competence.md docs/specs/04-channels.md docs/specs/13-office-identity.md docs/specs/14-autonomy-engine.md
git commit -s -m "docs: revise ADR-029 + specs for LLM-based voice & shadow assessment"
```

---

### Task 12: CHANGELOG + full sweep

**Files:**
- Modify: `CHANGELOG.md`
- Verify: whole worktree

- [ ] **Step 1: CHANGELOG** — under `## [Unreleased]` → `### Changed`, add (≤15 words each):

```
- **Voice learning** — LLM maintains a free-form writing-voice guide from draft→sent edits; replaces heuristics. (#1419)
- **Shadow competence** — LLM judges substantive decision equivalence (batched, binary flag); replaces token heuristics. (#1419)
- **Sensitivity** — shadow capture + task risk reuse the shared SensitivityClassifier; sensitive threads now included. (#1419)
```

- [ ] **Step 2: Full typecheck**

Run: `pnpm run typecheck`
Expected: clean across all four projects.

- [ ] **Step 3: Full targeted test sweep**

Run: `npx vitest run skills/ceo-inbox-sent-observe skills/voice-learn skills/task-completion-from-sent skills/list-learning-digest skills/resolve-learning-digest skills/ceo-inbox-shadow-draft skills/ceo-inbox-draft-reply skills/ceo-inbox-draft-edit skills/ceo-inbox-draft-compose skills/_shared src/executive src/skills tests/unit/autonomy`
Expected: all pass.

- [ ] **Step 4: Commit + push**

```bash
git add CHANGELOG.md
git commit -s -m "docs: changelog for LLM-based email-observation redesign (#1419)"
git push origin HEAD:cursor/email-observation-learning-e945
```

- [ ] **Step 5: Confirm CI green** — `gh pr checks 1429 --repo josephfung/curia` (gitleaks may need a re-run on a transient GH 500; the main `ci` job must be green).

---

## Self-review notes

- **Spec coverage:** voice guide (T1,7,8,9), weekly LLM pass (T8), shadow LLM batched judge (T5,6), sensitive-threads-included (T5,6,10,11), SensitivityClassifier reuse (T3,4), skillVersion on ctx (T2), agent version/prompt (T10), ADR/spec edits (T11), tests throughout, CHANGELOG (T12). All spec sections mapped.
- **Ordering / typecheck redness:** Tasks 7 and 8 intentionally leave `pnpm run typecheck` red (deleted symbols still referenced by resolve-learning-digest) until Task 9 closes the loop. This is called out in those tasks so an implementer doesn't "fix" consumers prematurely. Every other task ends typecheck-clean and independently testable.
- **Type consistency:** `ShadowJudgePair`/`ShadowJudgement`/`buildShadowJudgePrompt`/`parseShadowJudgeResult` (T5) consumed verbatim in T6; `buildVoiceGuidePrompt`/`ParsedDiffPair` (T7) consumed in T8; guide-proposal block format defined in T8 consumed by `parseVoiceGuideProposal` in T9; `classifyTaskRisk(task, classify)` signature (T4) matches its handler call.
- **No placeholders:** every code step shows real code; test steps show real assertions.
