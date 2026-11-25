# Inbox filing mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-mailbox `ceo_inbox/filing` setting that, under `leave_in_inbox`, makes triage mark mail read instead of archiving it (#2699).

**Architecture:** A small setting module beside `triage-cadence.ts` parses and validates the value. `config-store` refuses bad writes like it does for `sending`/`triage`. `ceo-inbox-archive` reads the setting on system-lineage turns only (the inbox drain and the resumes it starts) and marks read instead of archiving; the agent prompt and onboarding text learn the setting.

**Tech Stack:** TypeScript (ESM), Vitest, Nylas via `skills/_shared/principal-mailbox-client.ts`, KG-backed `ConfigStore`.

**Spec:** `docs/wip/2026-11-25-inbox-filing-mode-design.md`

## Global Constraints

- Key: namespace `ceo_inbox`, key `filing`, value `{"<mailbox id>": "archive" | "leave_in_inbox"}`.
- Unlisted mailbox, missing setting, unparseable value or unknown mode → `archive`.
- The setting applies only on system-lineage turns (`hasSystemLineage`: the inbox drain and the resumes it starts, such as calendar-consult replies); a principal-originated `ceo-inbox-archive` call always archives. (Widened from drain-only by the final review, which found consult resumes archiving.)
- Never log the stored value; mailbox ids are fine.
- No version bumps in `tool.json`, `SKILL.md` or `agents/*.yaml`.
- No console UI. No paid scenario runs.
- Commits signed off (`git commit -s`), no AI attribution trailer.
- Run `pnpm -C <worktree> run typecheck` before each commit touching `.ts`.

## Review Focus

1. Setting unreadable on a drain turn (no `entityMemory`, `ConfigStore.get` throws) → archive and warn; never fail the call (else the message is re-triaged forever). Test in Task 3.
2. `leave_in_inbox` on a message already out of the inbox → report `already_archived` as today, no mark-read PUT. Test in Task 3.
3. Mark-read fails under `leave_in_inbox` → `success: false` with the Nylas failure, so step 5's retry path applies. Test in Task 3.
4. Setting names mailbox A only; message is in mailbox B → B archives. Test in Task 3.
5. A principal-lineage turn, or an `agent` turn not laddered from system → archives without reading the setting. Test in Task 3.

---

### Task 1: Filing-mode setting module

**Files:**
- Create: `src/principal-mailboxes/filing-mode.ts`
- Test: `tests/unit/principal-mailboxes/filing-mode.test.ts`

**Interfaces:**
- Produces:
  - `export type FilingMode = 'archive' | 'leave_in_inbox'`
  - `export const FILING_KEY = 'filing'` (namespace is `TRIAGE_NAMESPACE` from `triage-state.ts`, i.e. `ceo_inbox`)
  - `export const DEFAULT_FILING_MODE: FilingMode = 'archive'`
  - `export function readFilingMode(raw: string | null, mailbox: string): { mode: FilingMode; malformed: boolean }`
  - `export function checkFilingWrite(raw: string, live: ReadonlyArray<{ id: string; label: string }>): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests**

```ts
describe('readFilingMode', () => {
  it('null → archive, not malformed', () => expect(readFilingMode(null, 'work')).toEqual({ mode: 'archive', malformed: false }));
  it('reads the mailbox own entry', () => expect(readFilingMode('{"work":"leave_in_inbox"}', 'work')).toEqual({ mode: 'leave_in_inbox', malformed: false }));
  it('another mailbox entry never applies', () => expect(readFilingMode('{"work":"leave_in_inbox"}', 'home')).toEqual({ mode: 'archive', malformed: false }));
  it.each(['not json', '[]', '"leave_in_inbox"', '{"work":"keep"}', '{"work":true}'])('%s → archive, malformed', (raw) =>
    expect(readFilingMode(raw, 'work')).toEqual({ mode: 'archive', malformed: true }));
});
describe('checkFilingWrite', () => {
  const live = [{ id: 'work', label: 'Work' }, { id: 'home', label: 'Personal' }];
  it('accepts live ids with valid modes', () => expect(checkFilingWrite('{"work":"leave_in_inbox","home":"archive"}', live)).toEqual({ ok: true }));
  it('refuses with no mailboxes', () => expect(checkFilingWrite('{}', [])).toMatchObject({ ok: false }));
  it('refuses non-JSON and non-objects', () => { expect(checkFilingWrite('x', live).ok).toBe(false); expect(checkFilingWrite('[]', live).ok).toBe(false); });
  it('refuses an unknown mailbox, naming it and the live ones', () => {
    const r = checkFilingWrite('{"wrk":"archive"}', live);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('wrk'); expect(r.error).toContain('work (Work)'); expect(r.error).toContain('Nothing was stored'); }
  });
  it('refuses an unknown mode, naming the mailbox', () => {
    const r = checkFilingWrite('{"work":"keep"}', live);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('work');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C <worktree> exec vitest run tests/unit/principal-mailboxes/filing-mode.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/principal-mailboxes/filing-mode.ts`**

Mirror `checkTriageCadenceWrite` (`triage-cadence.ts:228`) for the write check, including the `ADD_PRINCIPAL_MAILBOX_HINT` message for no mailboxes and a `shape` line `Store a JSON object {"<mailbox id>":"archive" | "leave_in_inbox"}. Mailboxes: <id (label), …>. Nothing was stored.`. Mirror `readSendLevelValue` (`send-level.ts:35`) for the read, without the legacy `default` key. Header comment names #2699.

- [ ] **Step 4: Run to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/principal-mailboxes/filing-mode.ts tests/unit/principal-mailboxes/filing-mode.test.ts
git -C <worktree> commit -s -m "feat(ceo-inbox): ceo_inbox/filing setting parser and write check (#2699)"
```

### Task 2: config-store validates `ceo_inbox/filing`

**Files:**
- Modify: `skills/config-store/handler.ts:90-123` (mailbox-keyed checks)
- Test: `skills/config-store/handler.test.ts` (new `describe` beside `— ceo_inbox/sending`, line 663)

**Interfaces:**
- Consumes: `checkFilingWrite`, `FILING_KEY` from Task 1.

- [ ] **Step 1: Write the failing tests** in `describe('ConfigStoreHandler — ceo_inbox/filing (#2699)')`, reusing the file's `makeCtx`, `makeEntityMemory` and the `mailboxView`/`directory` helpers from the sending block:
  - `stores {"work":"leave_in_inbox"}` → `success: true`, and the success data carries `mailboxes: [{ id, label }…]` like sending.
  - `refuses {"wrk":"archive"}` → `success: false`, error contains `wrk`, entity memory got no write.
  - `refuses {"work":"keep"}` → `success: false`.
  - `refuses when mailboxDirectory is absent` → `success: false`, error contains `ceo_inbox/filing cannot be checked`.
  - `refuses when the directory list throws` → `success: false`.
  - `matches CEO_INBOX / " filing " case and padding` → still validated (refuses `{"wrk":"archive"}`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C <worktree> exec vitest run skills/config-store/handler.test.ts`
Expected: the new tests FAIL (writes stored unchecked).

- [ ] **Step 3: Implement**

Add `namespace === TRIAGE_NAMESPACE && key === FILING_KEY` to the `mailboxKeyed` condition, and a block like the sending one that calls `checkFilingWrite(value, live.mailboxes)`, logs `'config-store: ceo_inbox/filing write refused — not live mailbox ids with valid modes'` at info, and sets `mailboxes` for the success result. Keep the code-owned-key regex unchanged (`filing` is principal-owned).

- [ ] **Step 4: Run to verify they pass**, plus the whole file. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(config-store): validate ceo_inbox/filing against live mailboxes (#2699)`.

### Task 3: `ceo-inbox-archive` leaves mail in the inbox on triage

**Files:**
- Create: `skills/_shared/inbox-drain-turn.ts` (move `isInboxDrainTurn` out of `skills/ceo-inbox/tools/ceo-inbox-list/handler.ts:47-58`, doc comment with it)
- Modify: `skills/ceo-inbox/tools/ceo-inbox-list/handler.ts` (import it; no behaviour change)
- Modify: `skills/ceo-inbox/tools/ceo-inbox-archive/handler.ts`
- Modify: `skills/ceo-inbox/tools/ceo-inbox-archive/tool.json` (add `"optional_capabilities": ["entityMemory"]`; output `left_in_inbox`)
- Test: `skills/ceo-inbox/tools/ceo-inbox-archive/handler.test.ts`

**Interfaces:**
- Consumes: `readFilingMode`, `FILING_KEY` (Task 1); `TRIAGE_NAMESPACE` from `src/principal-mailboxes/triage-state.ts`; `ConfigStore` from `src/memory/config-store.ts`.
- Produces: `export function isInboxDrainTurn(ctx: ToolContext): boolean` in `skills/_shared/inbox-drain-turn.ts`. Archive result data gains `left_in_inbox: true` when it marked read instead.

- [ ] **Step 1: Write the failing tests** in a new `describe('filing mode (#2699)')`. Use the `drainTurn` metadata shape from `ceo-inbox-list/handler.test.ts:944` (`{ originator: { systemRole: 'system' }, boundTask: { taskId: 't1', tags: ['inbox-drain'], createdBy: 'heartbeat' } }`), pass `entityMemory: {}` in the ctx, and stub `vi.spyOn(ConfigStore.prototype, 'get')`. Fetch sequence per existing tests: probe, GET message, then the write.
  - `drain turn + leave_in_inbox: marks read, keeps INBOX` — `get` resolves `'{"<located mailbox id>":"leave_in_inbox"}'`; message folders `['INBOX','Label_3']`; the third call is a PUT whose JSON body has `unread: false` and no `folders`; `result.data` has `left_in_inbox: true`, subject/sender, mailbox fields; no `already_archived`.
  - `drain turn + archive: archives` — `get` resolves `'{"<id>":"archive"}'`; PUT body `folders: ['Label_3']`; no `left_in_inbox`.
  - `drain turn + unset: archives` — `get` resolves `null`.
  - `principal turn ignores leave_in_inbox` — no drain metadata, `get` would return leave; archives and `get` is not called.
  - `agent turn not laddered from system archives`, and `consult resume (system lineage, no inbox-drain task) leaves in inbox`.
  - `other mailbox's entry does not apply` — with `twoMailboxFixture`, the setting names the mailbox not holding the message; archives.
  - `setting read throws → archives, success` — `get` rejects.
  - `no entityMemory → archives, success`.
  - `malformed value → archives` — `get` resolves `'not json'`.
  - `leave_in_inbox, message already out of INBOX → already_archived: true, no PUT`.
  - `leave_in_inbox, mark-read PUT fails (500) → success: false` with the existing `nylasMessageFailure` shape.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C <worktree> exec vitest run skills/ceo-inbox/tools/ceo-inbox-archive/handler.test.ts`
Expected: the leave_in_inbox tests FAIL.

- [ ] **Step 3: Implement**

Add `private async filingMode(ctx, mailboxId): Promise<FilingMode>`: returns `'archive'` unless `hasSystemLineage(ctx.taskMetadata)`; without `ctx.entityMemory` warns `'ceo-inbox-archive: filing mode unreadable on a drain turn; archiving'` and returns `'archive'`; reads `new ConfigStore(ctx.entityMemory, ctx.log).get(TRIAGE_NAMESPACE, FILING_KEY)` in a try/catch that warns with `errName` and the same message; warns `{ mailbox }` `'ceo_inbox/filing is malformed; archiving'` when `malformed`. In `execute`, after the already-archived check: if mode is `leave_in_inbox`, `await client.markAsRead(messageId)`, log info `'ceo-inbox-archive: left in inbox, marked read (ceo_inbox/filing)'`, return `{ message_id, ...described, left_in_inbox: true, ...mbx }`. The existing catch covers a mark-read failure. Use the located mailbox's `id` (from `located.at.mailbox`) as the setting key.

- [ ] **Step 4: Run to verify they pass**, plus `skills/ceo-inbox/tools/ceo-inbox-list/handler.test.ts` (the move must not change it). Expected: PASS.

- [ ] **Step 5: Update `tool.json`**: description adds one sentence: `During triage, a mailbox whose ceo_inbox/filing is leave_in_inbox is marked read instead and stays in the inbox.`; output `"left_in_inbox": "boolean (true when the mailbox's filing setting kept it in the inbox, marked read; omitted otherwise)"`. Run `pnpm -C <worktree> exec vitest run tests/unit/agents/prompt-budget.test.ts tests/unit/skills` and, if ceo-inbox's `localToolDefinitionBytes` budget fails, raise it by the measured growth with a dated comment line in the file's existing style (`// #2699 …`).

- [ ] **Step 6: Typecheck and commit** — `feat(ceo-inbox): leave triaged mail in the inbox under ceo_inbox/filing (#2699)`.

### Task 4: ceo-inbox agent prompt

**Files:**
- Modify: `agents/ceo-inbox.yaml` (pinned_context configs at line 34-40; Step 2 at 386-395; Step 5 at 850-863; Rule Management at 926-948)
- Modify: `tests/unit/agents/prompt-budget.test.ts` only if the always-on budget fails

- [ ] **Step 1: Pin the setting.** Add after `ceo_inbox/triage`:

```yaml
    - key: ceo_inbox/filing
      description: '{"<mailbox id>": "archive" | "leave_in_inbox"}; unlisted = archive. leave_in_inbox: triage marks mail read instead of archiving it (code applies it).'
```

- [ ] **Step 2: Step 5 note.** Under **Archived**, add: `A ceo-inbox-archive result with left_in_inbox: true was marked read instead (the mailbox's filing setting); it is settled too.`

- [ ] **Step 3: Rule Management.** Add after the triage cadence line: `- **Filing:** the same, key \`filing\`, value \`{"<mailbox id>":"archive" | "leave_in_inbox"}\`.` Extend the section's first sentence to name filing.

- [ ] **Step 4: Run** `pnpm -C <worktree> exec vitest run tests/unit/agents tests/unit/startup/agent-assembly.test.ts scripts/inspect-prompts.test.ts`. If the ceo-inbox always-on budget fails, raise it by the measured growth with a `// #2699` comment. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(ceo-inbox): agent knows the filing setting (#2699)`.

### Task 5: Onboarding inbox topic

**Files:**
- Modify: `config/onboarding/playbook.md:64-85`
- Modify: `skills/onboarding/SKILL.md:69-71`

- [ ] **Step 1: Playbook.** Replace the Seen and Cleared lines and add the choice:

```
- Seen: worth knowing; marked read and labelled, and it stays in your inbox.
- Cleared: noise; marked read and filed out of your inbox.
```

Handled and Drafted lines gain "and filed out of your inbox". Under Choices add, before calendar:
`- Should mail I've dealt with leave your inbox, or stay there marked read? (\`ceo_inbox/filing\`, per mailbox)`
Read-back line becomes: `I finish with a read-back that reflects these choices: "From tomorrow morning you'll see...".`

- [ ] **Step 2: Onboarding skill.** In "What you'll notice in your inbox", replace the parenthetical with `(Seen, Urgent and Stuck mail stays in the inbox, marked read; Cleared, Handled and Drafted mail is filed out of it unless the principal keeps it there; drafts appear in Drafts)`, and add `keep dealt-with mail in the inbox, marked read: \`ceo_inbox/filing\`, per mailbox, ask per mailbox only if they want them to differ` to the choices.

- [ ] **Step 3: Run** `pnpm -C <worktree> exec vitest run tests/unit/onboarding skills/onboarding`. Expected: PASS (playbook parser still finds `inbox-expectations` with `needsMailbox`).

- [ ] **Step 4: Commit** — `feat(onboarding): offer the inbox filing choice and describe Seen mail correctly (#2699)`.

### Task 6: Changelog fragment and full checks

**Files:**
- Create: `changes/feat-2699-inbox-filing-mode.md`

- [ ] **Step 1: Write the fragment**

```markdown
### Added

- **Inbox filing setting** — per mailbox, triage can leave dealt-with mail in the inbox, marked read. (#2699)
```

- [ ] **Step 2: Run** `pnpm -C <worktree> run typecheck`, `pnpm -C <worktree> run lint`, and `pnpm -C <worktree> exec vitest run tests/unit skills`. Expected: all PASS (integration suite is not required for this change).

- [ ] **Step 3: Commit** — `chore: changelog fragment for #2699`.

### Task 7: curia-docs

**Files (in a new worktree `~/Projects/curia/worktrees/curia-docs-2699-inbox-filing` off curia-docs `main`):**
- Modify: `get-started/principal-email-calendar.mdx:107` ("What your principal will notice")
- Modify: `agents/built-in-agents.mdx:126`

- [ ] **Step 1:** Replace "Messages it has dealt with are marked read or archived." with: "Messages it has dealt with are marked read. Noise, handled mail and mail it drafted a reply to is also archived, unless your principal asks to keep it in the inbox (\"leave my work email in the inbox\"). That choice is per mailbox and is also offered during onboarding."
- [ ] **Step 2:** In built-in-agents, after the decision-tagging sentence add: "A per-mailbox filing setting (`ceo_inbox/filing`) keeps triaged mail in the inbox, marked read, instead of archiving it."
- [ ] **Step 3:** Commit signed off; open as a separate curia-docs PR linked from the curia PR.
