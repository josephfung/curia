# Onboarding Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build #2360: an operator-started onboarding in which Curia does its homework, greets the
principal, runs a playbook-driven first conversation by chat or voice, and books later sessions on
the principal's calendar, ending when every onboarding subtask is done.

**Architecture:** One onboarding task (tag `onboarding`) with one subtask per playbook topic. The
playbook is an OKF doc seeded from a repo default. An `onboarding` skill bundle carries the
behaviour; the runtime activates it on onboarding task wakes and on live principal turns while the
task is open. Deterministic rules (triage hold, band limit, follow-up caps, agenda/event sync) are
code in `src/onboarding/` and `src/meetings/`.

**Tech Stack:** TypeScript (ESM, Node 26), Vitest, PostgreSQL, Fastify routes, React console
(`apps/console`), existing bus/scheduler/task/OKF services.

**Spec:** `docs/wip/2026-11-20-onboarding-program-design.md` (read it first; section numbers below
refer to it).

## Global Constraints

- Branch `feat/2360-onboarding-program`, worktree `~/Projects/curia/worktrees/curia-2360-onboarding-program`.
- Every commit signed off: `git commit -s`. No `Co-Authored-By` or "Generated with" lines.
- `pnpm -C <worktree> run typecheck` before every commit touching `.ts`.
- New skills/tools start at version `"0.1.0"`; never bump existing versions.
- Every new tool declares `action_risk`. No `${...}` in any `tool.json`.
- No migration is expected. If one becomes necessary, it is `132_*` and you check `ls src/db/migrations | sort` for a unique prefix.
- The coordinator's always-on prompt must not grow (`tests/unit/agents/prompt-budget.test.ts`).
- Voice tool list (`src/channels/voice/voice-tools.ts`) does not change.
- Tests stay light: unit-test only the deterministic rules named in each task. No tests that pin prompt or playbook wording.
- Do **not** run `pnpm scenarios` (paid). Writing scenario cases is fine.
- Synthetic principals only in fixtures (public repo).
- Constants live in `src/onboarding/constants.ts`: `GREETING_FOLLOWUPS = 2`, `GREETING_FOLLOWUP_GAP_HOURS = 48`, `CHAT_IDLE_NUDGE_HOURS = 4`, `NO_SHOW_GRACE_MINUTES = 30`, `SESSION_NUDGE_LEAD_MINUTES = 15`, `WATCHER_INTERVAL_MINUTES = 15`, `ONBOARDING_BANDS = [65, 75, 85]`.
- Paths: playbook `/meetings/onboarding/playbook.md`; research brief `/meetings/onboarding/research-brief.md`; parent task tag `onboarding`; subtask tags `onboarding`, `onboarding:topic:<topicId>`, `onboarding:session:<sessionId>`.
- Config-store keys: `onboarding/triage_hold` (value `'{"held":true}'`), `onboarding/state` (JSON, §Task 2).

## Review Focus

1. **Existing installs (prod).** No `onboarding/triage_hold` key and no onboarding task → heartbeat triages exactly as before, no dashboard alert, no injection, no watcher activity. Pinned by tests in Tasks 3, 7, 9.
2. **Start pressed twice / concurrently** (double-click, two tabs) → one onboarding task, one greeting. Pinned in Task 4 (second call returns 409 `already_started`).
3. **Principal sends a side request mid-onboarding** → normal coordinator turn with onboarding context added, not refused. Covered by Task 7's injection being additive (test: injected turn still has the coordinator's normal tools).
4. **Playbook edited badly by the operator** (topic ids removed, a session heading deleted, empty file) → parser still yields topics (ids derived from headings), Start never throws; an empty/missing session yields zero subtasks and a warn log. Pinned in Task 1.
5. **Calendar event deleted or unreadable** (404, grant revoked) → the sweep wakes the owner task once with "cancelled", never loops or crashes the sweep. Pinned in Task 10.

---

### Task 1: Playbook default, parser and seeding

**Files:**
- Create: `config/onboarding/playbook.md` (the default; Curia's voice, "Getting to know {principal}")
- Create: `src/onboarding/playbook.ts`
- Modify: `src/channels/http/routes/setup.ts` (`POST /api/setup/start` seeds after `startSetup`)
- Test: `tests/unit/onboarding/playbook.test.ts`

**Interfaces:**
- Produces:
  - `type PlaybookTopic = { id: string; title: string; body: string; needsMailbox: boolean }`
  - `type PlaybookSession = { id: string; title: string; topics: PlaybookTopic[] }`
  - `parsePlaybook(markdown: string): PlaybookSession[]` — `#` = session, `##` = topic; id from `<!-- topic: x -->` / `<!-- session: x -->` comment, else slug of the heading; `needsMailbox` true when the topic body contains the line `Needs: mailbox`.
  - `PLAYBOOK_PATH = '/meetings/onboarding/playbook.md'`
  - `seedPlaybook(repo: WorkingDocsRepo, logger: Logger): Promise<'created' | 'exists'>` — creates the doc from `config/onboarding/playbook.md` (read via `import.meta.dirname`-relative path, resolved the same way other `config/` files are loaded) only if absent; never overwrites.
  - `readPlaybook(repo: WorkingDocsRepo): Promise<PlaybookSession[]>` — seeds if missing, then parses.

**Playbook content** (sessions and topic ids, in order; write each topic in Curia's voice per design §1 and §7, with suggested questions/options):
- `first-conversation`: `hello`, `about-you` (opens from the research brief), `style`, `independence`, `reach-you`, `connect-mailbox` (Needs: mailbox is false — it is the connect step), `inbox-expectations` (Needs: mailbox), `spoken-voice`, `drives-imports`, `review-format`, `first-look` (Needs: mailbox), `next-step`.
- `review`: `walk-drafts`, `next-step`.
- `check-in`: `since-last-time`, `corrections`, `next-step`.
- `ongoing-rhythm`: `propose-rhythm` (weekly or other cadence, or none).
- `weekly`: `independence`, `feature-upkeep`, `new-plays`, `priorities` (used for recurring sessions after onboarding).

The `inbox-expectations` topic must cover the six categories (Urgent, Handled, Drafted, Seen, Cleared, Stuck), what each looks like in the mailbox (Seen/Cleared marked read and leave the inbox; drafts appear in Drafts; Urgent reaches them on their channel; Stuck is labelled), the labels choice (`ceo_inbox/decision_tagging`), the sending choice (`ceo_inbox/sending`), calendar holds and booking at the chosen band, and a "from tomorrow morning you'll see…" read-back.

- [ ] **Step 1: Write failing tests** — `parsePlaybook` on a small inline fixture returns sessions/topics with explicit ids; headings without id comments get slug ids (`'How I should sound'` → `'how-i-should-sound'`); `Needs: mailbox` sets `needsMailbox`; `''` returns `[]`; text before the first `#` is ignored. Also parse the real `config/onboarding/playbook.md` and assert the session ids above exist and `first-conversation` contains `inbox-expectations` with `needsMailbox: true`. `seedPlaybook` with an in-memory fake repo: creates once, returns `'exists'` the second time and does not call update.
- [ ] **Step 2: Run** `pnpm -C <wt> exec vitest run tests/unit/onboarding/playbook.test.ts` → FAIL.
- [ ] **Step 3: Implement** the playbook file and `src/onboarding/playbook.ts`; call `seedPlaybook` from `POST /api/setup/start` after `startSetup(pool)` when Setup actually started (log and continue on failure: seeding is best-effort, re-attempted at Start).
- [ ] **Step 4: Run** tests → PASS; `pnpm -C <wt> run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(onboarding): playbook default, parser and seeding (#2360)`.

### Task 2: Onboarding state, constants and `notifyOperator`

**Files:**
- Create: `src/onboarding/constants.ts` (values in Global Constraints)
- Create: `src/onboarding/state.ts`
- Create: `src/onboarding/notify-operator.ts`
- Test: `tests/unit/onboarding/state.test.ts`

**Interfaces:**
- Produces:
  - `type OnboardingState = { taskId: string; startedAt: string; route: MessagingRoute; greetingSentAt: string | null; followUpsSent: number; lastFollowUpAt: string | null; lastPrincipalTurnAt: string | null; idleNudgeSentAt: string | null; operatorNotified: OperatorEvent[] }`
  - `readOnboardingState(store: Pick<ConfigStore,'get'>): Promise<OnboardingState | null>` (namespace `onboarding`, key `state`; malformed JSON → warn log and `null`)
  - `writeOnboardingState(store: Pick<ConfigStore,'set'>, s: OnboardingState): Promise<void>`
  - `findOpenOnboardingTask(taskRepo: Pick<TaskRepo,'listTasks'>): Promise<TaskRow | null>` — parent task (tag `onboarding`, no `parentTaskId`, non-terminal status).
  - `type OperatorEvent = 'greeting_unanswered' | 'invitation_expired' | 'web_search_failed' | 'mailbox_signin_blocked'`
  - `notifyOperator(deps: { taskRepo: Pick<TaskRepo,'updateTask'>; logger: Logger; audit?: (e: Record<string, unknown>) => void }, taskId: string, event: OperatorEvent, details?: Record<string, unknown>): Promise<void>` — adds a progress note `Operator notice: <event>`, logs at warn, audits; body carries `// TODO(#2365): deliver to the operator once the operator role exists.` Never throws (catch → log error).

- [ ] **Step 1: Failing tests** — state round-trips through a fake store; malformed JSON reads as `null`; `findOpenOnboardingTask` ignores subtasks and terminal tasks; `notifyOperator` writes the progress note and swallows an `updateTask` rejection (logs error).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): state, constants and notifyOperator placeholder (#2360)`.

### Task 3: Triage hold

**Files:**
- Create: `src/onboarding/triage-hold.ts`
- Modify: `src/scheduler/inbox-heartbeat.ts` (`InboxHeartbeatOptions` gains `held?: () => Promise<boolean>`; checked first in `tickOnce`, returns `'quiet'` and logs debug when held)
- Modify: `src/index.ts` (pass `held` built from the config store when constructing `InboxHeartbeat`)
- Modify: `src/channels/http/routes/registry.ts` or the capabilities status source the console reads, plus `apps/console/src/pages/capabilities/CapabilitiesSection.tsx`: show "Held until {principal} hears what to expect" for Email triage when held; switching Email triage on in Settings calls `DELETE /api/onboarding/triage-hold` (Task 4 adds the route) before the registry calls.
- Test: `tests/unit/onboarding/triage-hold.test.ts`, extend `tests/unit/scheduler/inbox-heartbeat.test.ts`

**Interfaces:**
- Produces:
  - `isTriageHeld(store: Pick<ConfigStore,'get'>): Promise<boolean>` — missing key → `false`; `{"held":true}` → `true`; malformed → `true` and warn (fail closed: an unreadable hold must not start labelling a mailbox nobody was told about).
  - `setTriageHold(store: Pick<ConfigStore,'set'>): Promise<void>`; `releaseTriageHold(store): Promise<void>` (writes `{"held":false}`).
- Decision (recorded in design §8 by this task): the hold gates the **heartbeat only**, the sole thing that wakes scheduled triage. Principal-directed tool calls still work.

- [ ] **Step 1: Failing tests** — `isTriageHeld` for missing/true/false/malformed; heartbeat with `held: async () => true` returns `'quiet'` and never calls `taskRepo.createTask` or `scheduler.enqueueTaskWake`; with `held` absent the existing tests still pass unchanged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; update design §8's "Enforced in code" line to "Enforced in code at the inbox heartbeat, which is the only thing that wakes scheduled triage; principal-directed mailbox actions are unaffected."
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): triage hold gates the inbox heartbeat (#2360)`.

### Task 4: Starting onboarding (server)

**Files:**
- Create: `src/onboarding/onboarding-service.ts`
- Create: `src/channels/http/routes/onboarding.ts`
- Modify: `src/setup/complete-setup.ts` (stop rotating the thread; only `markSetupComplete`)
- Modify: `src/channels/http/http-adapter.ts` (register `onboardingRoutes`), `src/index.ts` (construct `OnboardingService`)
- Modify: `agents/setup-wizard.yaml` "Finishing Setup" text: Start onboarding or Not right now; the dashboard keeps Start available.
- Test: `tests/unit/onboarding/onboarding-service.test.ts`, update `tests/unit/setup/complete-setup.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `RegistryService.installAndEnable(kind, name, actor)`; `TaskRepo.createTask`, `setActiveSkillsBlock`, `replaceActiveSkillsBlock`; `SchedulerService.enqueueTaskWake`; `rotateWebThreadRow`/`noteWebThreadRotated` (`src/channels/http/web-thread.ts`); pairing invitation mint (`src/channels/http/pairing-invitations.ts`); `readSetupState`.
- Produces:
  - `class OnboardingService { constructor(deps: OnboardingServiceDeps); status(): Promise<OnboardingStatus>; start(opts: { actor: 'operator' | 'principal'; confirmWorkingPrincipal?: boolean }): Promise<StartResult> }`
  - `type OnboardingStatus = { started: boolean; taskId: string | null; showDashboardAlert: boolean; workingPrincipalSignals: string[]; route: MessagingRoute | null; setupFor: SetupFor | null; principalName: string | null }` — `showDashboardAlert` = not started AND `setup_state.completed_at` not null AND phase complete.
  - `type StartResult = { ok: true; taskId: string; invitation: { url: string; expiresAt: string } | null; restartScheduled: boolean } | { ok: false; code: 'already_started' | 'confirm_working_principal' | 'setup_incomplete'; signals?: string[] }`
  - Routes (all `requireAuth`): `GET /api/onboarding/status` → `OnboardingStatus`; `POST /api/onboarding/start` body `{ confirmWorkingPrincipal?: boolean }` → 200 `StartResult` ok, 409 on `already_started`/`confirm_working_principal`/`setup_incomplete`; `DELETE /api/onboarding/triage-hold` → releases the hold (used by Capabilities).
- `start()` order (one transaction where DB-only; idempotency guarded by `pg_advisory_xact_lock` via the same helper `KnowledgeGraphStore.withAdvisoryLock` uses, keyed `onboarding:start`):
  1. `setup_incomplete` unless setup phase is complete.
  2. `already_started` if `findOpenOnboardingTask` returns a task.
  3. Working-principal signals (any of: Email triage agent `ceo-inbox` already enabled in registry; tasks created before `setup_state.completed_at` with `source = 'ceo'`) → `confirm_working_principal` unless confirmed.
  4. `setTriageHold`; `installAndEnable` for agent `ceo-inbox`, skills `ceo-inbox`, `learning`, `tasks` (skip ones already enabled); `restartScheduled = true` if any were newly enabled.
  5. `readPlaybook` (seeds). Create parent task: `agentId 'coordinator'`, `owner 'curia'`, `source 'scheduler'`, `createdBy 'onboarding'`, `title 'Onboarding: getting to know {principalName}'`, `tags ['onboarding']`, `originator makeSystemOriginator()`. Create one subtask per `first-conversation` topic (`parentTaskId`, tags per Global Constraints, title = topic title). `setActiveSkillsBlock(parent, replaceActiveSkillsBlock(['onboarding']))`.
  6. Create the homework task: child of parent, title `Homework: research {principalName} and map shared drives`, tags `['onboarding','onboarding:homework']`, active skill `onboarding`, wake now.
  7. Rotate the web thread (`rotateWebThreadRow` in the transaction, `noteWebThreadRotated` after commit).
  8. Route: app → mint invitation (48h), return it; greeting waits for redemption (Task 8). Signal/SMS/Slack → progress note `Send the greeting` on parent and wake now. Write `OnboardingState`.
  9. If `restartScheduled`, call the injected `scheduleProcessExit` after the response is sent (same mechanism `setupRoutes` uses), and the wakes fire after boot.

- [ ] **Step 1: Failing tests** (fakes for repo/registry/scheduler/store) — start on incomplete setup → `setup_incomplete`; second start → `already_started` and no second task; working-principal signal → `confirm_working_principal`, then succeeds with `confirmWorkingPrincipal: true`; success creates 1 parent + N subtasks (N = first-conversation topics) + 1 homework task, sets the hold, enables the four registry entries, sets active skill `onboarding`; app route returns an invitation and enqueues no greeting wake; signal route enqueues a wake on the parent; `status()` on an install whose `completed_at` is null → `showDashboardAlert: false`. `completeSetup` no longer rotates the thread (update its test).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): start onboarding seeds the task, holds triage and reaches the principal (#2360)`.

### Task 5: The `onboarding` skill bundle and its tools

**Files:**
- Create: `skills/onboarding/SKILL.md` (frontmatter `name: onboarding`, `version: "0.1.0"`, `tools: [onboarding-progress, onboarding-triage-release, onboarding-start]`; body = the rules in design §6 and §7: Curia adapting to the principal, any topic order, multiple choice with read-back, apply-then-mark-done, side requests become their own tasks, deferral handling (named day → book it; vague "later" → offer two times once), homework rules (professional public footprint only; brief items unconfirmed until confirmed; namesake caution; never mention research in the greeting), first look rules (7 days back/forward, 3–4 facts with offers), greeting content (design §5), voice: park an agenda from open subtasks + playbook text + brief, chat: one topic at a time)
- Create: `skills/onboarding/tools/onboarding-progress/{tool.json,handler.ts,handler.test.ts}`
- Create: `skills/onboarding/tools/onboarding-triage-release/{tool.json,handler.ts,handler.test.ts}`
- Create: `skills/onboarding/tools/onboarding-start/{tool.json,handler.ts,handler.test.ts}`
- Modify: `config/registry-defaults.yaml` (`skills:` add `onboarding`); pin `mailbox-signin-link` access for the coordinator only via the skill (add it to the bundle's `tools:` list if a standalone tool can be listed in two places; otherwise note in SKILL.md to `skill-activate mailbox-signin-link`).

**Interfaces:**
- Consumes: Tasks 1–4 (`findOpenOnboardingTask`, `readPlaybook`, state, `notifyOperator`, `releaseTriageHold`, `OnboardingService.start`). Expose the service to handlers through a new ToolContext capability `onboardingService` following how `officeIdentityService` is declared in `capabilities`.
- Produces tools (all `allowed_callers: ["coordinator"]`):
  - `onboarding-progress` (`action_risk: "low"`), input `action`:
    - `"status"` → `{ taskId, sessions: [{ id, title, open: [{ topicId, title, body, needsMailbox }], done: [...] }], mailboxConnected: boolean, greetingSent: boolean }`
    - `"open_session"` + `session_id` → creates subtasks for that playbook session if none exist yet (idempotent), returns its topics.
    - `"topic_done"` + `topic_id` + `outcome: "done" | "declined"` + `note` → completes the subtask with the note; when the `ongoing-rhythm` session has no open subtasks and no other subtask is open, completes the parent task.
    - `"greeting_sent"` → sets `greetingSentAt` in state.
    - `"operator_notice"` + `event` (OperatorEvent) + `details?` → `notifyOperator`.
  - `onboarding-triage-release` (`action_risk: "low"`, principal-authorized): refuses unless the `inbox-expectations` subtask is done; then `releaseTriageHold`.
  - `onboarding-start` (`action_risk: "low"`, principal-authorized): calls `OnboardingService.start({ actor: 'principal', confirmWorkingPrincipal: true })`.

- [ ] **Step 1: Failing handler tests** — `topic_done` completes the subtask and, for the last open subtask of `ongoing-rhythm`, the parent; `open_session` twice creates subtasks once; triage-release refuses before `inbox-expectations` is done and releases after; unknown `topic_id` returns `{ success: false }` naming valid ids.
- [ ] **Step 2: Run** `pnpm -C <wt> exec vitest run skills/onboarding` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck; `pnpm -C <wt> exec vitest run tests/unit/skills` (manifest checks) → PASS.
- [ ] **Step 5: Commit** `feat(onboarding): onboarding skill bundle and progress tools (#2360)`.

### Task 6: Tone tool and the onboarding band limit

**Files:**
- Create: `skills/executive-profile/tools/office-tone-update/{tool.json,handler.ts,handler.test.ts}`; add to `skills/executive-profile/SKILL.md` `tools:`
- Modify: `skills/autonomy/tools/set-autonomy/handler.ts` (+ its test)

**Interfaces:**
- `office-tone-update`: `capabilities: ["officeIdentityService"]`, `action_risk: "low"`, principal-authorized like `behavioral-preferences-update`; inputs `style?: string` (≤800 chars), `verbosity?: number` (0–100 integer); at least one required. Reads current identity, writes `tone` via `OfficeIdentityService.update(next, 'principal', note)`; returns `{ style, verbosity }`.
- `set-autonomy`: when `findOpenOnboardingTask(ctx.taskRepo)` returns a task and the rounded score is not in `ONBOARDING_BANDS`, return `{ success: false, error: 'During onboarding the independence level is 65 (Draft only), 75 (Ask first) or 85 (Spot-check).' }`.

- [ ] **Step 1: Failing tests** — tone: style too long rejected; verbosity 101 rejected; both absent rejected; valid call updates only `tone`. set-autonomy: with an open onboarding task, 80 rejected and 75 accepted; without one, 80 accepted.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): tone update tool and onboarding band limit (#2360)`.

### Task 7: Onboarding context on live principal turns

**Files:**
- Create: `src/onboarding/turn-context.ts`
- Modify: `src/agents/runtime.ts` (runtime config gains `onboardingTurnContext?: OnboardingTurnContextSource`; in `processTask`, when the turn is not task-bound and `isLivePrincipalTurn(liveTurn, metadata)` and the source returns a context: activate skill `onboarding` via `executionLayer.resolveSkillActivationForAgent` + `getToolDefinitions` + `formatActivatedSkillInstructionBlock` (same as the bound-task path), and prepend the context block to `promptContent`)
- Modify: `src/index.ts` (pass the source to the coordinator runtime only)
- Test: `tests/unit/onboarding/turn-context.test.ts`, extend the runtime test that covers bound-task skill restore

**Interfaces:**
- Produces:
  - `interface OnboardingTurnContextSource { forPrincipalTurn(now: Date): Promise<string | null> }`
  - `createOnboardingTurnContext(deps: { taskRepo; configStore; logger }): OnboardingTurnContextSource` — returns `null` when no open onboarding task; otherwise records `lastPrincipalTurnAt = now` in state and returns a block:
    `[Onboarding in progress — task <id>. Open topics this session: <title (topicId)>, … Use onboarding-progress to see and record progress. Handle anything else the principal asks as usual.]`
  - Failures inside `forPrincipalTurn` are logged and return `null` (fail open: a broken lookup must not break the principal's chat).

- [ ] **Step 1: Failing tests** — no open task → `null` and no state write; open task → block contains each open topic id, and state's `lastPrincipalTurnAt` updated; repo throws → `null` + error log. Runtime: a live principal turn with a source returning a block has the `onboarding` tools in its tool list and the block in the prompt; a non-principal or non-live turn calls nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck; `pnpm -C <wt> exec vitest run tests/unit/agents/prompt-budget.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(onboarding): live principal turns carry onboarding context (#2360)`.

### Task 8: Events and subscribers (invitation redeemed, mailbox connected)

**Files:**
- Modify: `src/bus/events.ts` (new `PairingInvitationRedeemedEvent`, type `'pairing.invitation_redeemed'`, `sourceLayer: 'system'`, payload `{ invitationId: string; deviceName: string }`, factory `createPairingInvitationRedeemed`); `src/bus/permissions.ts` (system publish + subscribe, `// #2360` comment)
- Modify: `src/channels/http/routes/pairing.ts` (publish after `recordPairedNotice` on the invitation path)
- Create: `src/onboarding/subscribers.ts`
- Modify: `src/index.ts` (wire `new OnboardingSubscribers({...}).start()` next to the meetings subscribers)
- Test: `tests/unit/onboarding/subscribers.test.ts`

**Interfaces:**
- `class OnboardingSubscribers { constructor(o: { bus; taskRepo; scheduler; configStore; logger }); start(): void }`
  - `pairing.invitation_redeemed` → if open onboarding task and `greetingSentAt` null: progress note `Phone app paired: send the greeting in the app` + wake now.
  - `principal_mailbox.connected` → if open onboarding task: progress note `Mailbox connected (<email>): run the first look; pick up connect-mailbox / inbox-expectations` + wake now. Leave `// #2362: the deep dive starts here.`
  - `mailbox_signin.finished` with a blocked outcome (`admin_blocked`, `org_internal`) → `notifyOperator(taskId, 'mailbox_signin_blocked', { outcome, clientId })` when an onboarding task is open.

- [ ] **Step 1: Failing tests** — each event with no open task does nothing; with an open task adds the note and enqueues one wake; redeemed after greeting already sent does nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): wake onboarding on pairing and mailbox connection (#2360)`.

### Task 9: Onboarding watcher (follow-ups, idle nudge, invitation expiry)

**Files:**
- Create: `src/onboarding/followup-policy.ts`, `src/onboarding/watcher.ts`
- Modify: `src/index.ts` (start the watcher; interval `WATCHER_INTERVAL_MINUTES`)
- Test: `tests/unit/onboarding/followup-policy.test.ts`

**Interfaces:**
- `decideNext(s: OnboardingState, now: Date, invitation: { expiresAt: Date; redeemed: boolean } | null): 'wait' | 'send_followup' | 'notify_greeting_unanswered' | 'idle_nudge' | 'notify_invitation_expired'` — pure:
  - invitation present, not redeemed, expired, `invitation_expired` not in `operatorNotified` → `notify_invitation_expired`;
  - greeting sent, `lastPrincipalTurnAt` null or before `greetingSentAt`: if `followUpsSent < GREETING_FOLLOWUPS` and `now - (last greeting/follow-up) ≥ GREETING_FOLLOWUP_GAP_HOURS` → `send_followup`; if exhausted and gap elapsed and not yet notified → `notify_greeting_unanswered`;
  - principal has replied, open first-conversation topics remain, `now - lastPrincipalTurnAt ≥ CHAT_IDLE_NUDGE_HOURS`, `idleNudgeSentAt` null or before `lastPrincipalTurnAt` → `idle_nudge`;
  - else `wait`.
- `class OnboardingWatcher { constructor(o); start(): void; stop(): void; tick(now: Date): Promise<void> }` — reads state + open task, applies `decideNext`, then: `send_followup` → note `Send follow-up <n> of <GREETING_FOLLOWUPS>` + wake + increment; `idle_nudge` → note `Principal went quiet mid-conversation: one gentle nudge` + wake + set `idleNudgeSentAt`; notify actions → `notifyOperator` + record. A tick error is logged, never thrown.

- [ ] **Step 1: Failing tests** for `decideNext`: each branch above, plus: reply after greeting → never `send_followup`; follow-ups never exceed `GREETING_FOLLOWUPS`; notify happens once.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(onboarding): capped greeting follow-ups, idle nudge and invitation expiry (#2360)`.

### Task 10: Agendas tied to calendar events (follow, nudge, no-show)

**Files:**
- Modify: `src/meetings/types.ts` (`ParkAgendaInput` gains `calendarEventId?: string | null; calendarId?: string | null; ownerTaskId?: string | null`), `src/meetings/agenda-store.ts` (persist them in frontmatter, plus `nudgedAt`, `eventState: 'scheduled' | 'cancelled' | 'no_show' | null`; new `reschedule(agendaId, scheduledFor: Date)` and `markEvent(agendaId, patch)` using the existing version-conflict retry)
- Modify: `src/meetings/agenda-validation.ts` (`isDue`: an agenda with `calendarEventId` is due from 12h before `scheduledFor` until settled; others unchanged)
- Modify: `skills/meetings/tools/meeting-agenda-park/{tool.json,handler.ts}` (optional `calendar_event_id`, `calendar_id`, `owner_task_id`); `skills/meetings/SKILL.md` (one line: pass them when the call is a booked event)
- Create: `src/meetings/agenda-event-sync.ts`
- Modify: `src/index.ts` (run the sync on an interval next to the onboarding watcher)
- Test: `tests/unit/meetings/agenda-event-sync.test.ts`, extend `agenda-validation` tests

**Interfaces:**
- `class AgendaEventSync { constructor(o: { store: AgendaStore; getEvent: (calendarId: string, eventId: string) => Promise<{ start: Date; end: Date; status: 'confirmed' | 'cancelled' } | null>; taskRepo; scheduler; logger }); tick(now: Date): Promise<void> }` — for each pending agenda with `calendarEventId`:
  - `getEvent` returns `null` / throws not-found, or status cancelled → `markEvent(cancelled)` once, wake `ownerTaskId` with note `Session event cancelled: ask once when to do it instead`.
  - start moved → `reschedule`; clear `nudgedAt` if the new start is later.
  - `now ≥ start - SESSION_NUDGE_LEAD_MINUTES` and no `nudgedAt` → wake owner with `Session starting: nudge the principal (call, or open it in chat)`; set `nudgedAt`.
  - `now ≥ end + NO_SHOW_GRACE_MINUTES`, status still `pending`, history empty, `eventState` not `no_show` → `markEvent(no_show)`, wake owner with `Missed session: one "missed you, when suits better?"`.
  - Other errors from `getEvent` → warn and skip this agenda this tick.
  - In `src/index.ts`, `getEvent` wraps `calendarRouter.route(calendarId)` → `client.getEvent`, mapping Nylas 404 to `null`.
- Agendas with no `ownerTaskId` still get rescheduled/marked but wake nothing (log info).

- [ ] **Step 1: Failing tests** — moved event reschedules; cancelled wakes once across two ticks; 404 behaves as cancelled; nudge once; no-show once and not for an agenda that was loaded (history non-empty); `isDue` keeps an event-tied agenda due 20h after its start, and an untied one is not.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck; existing `tests/unit/meetings` pass.
- [ ] **Step 5: Commit** `feat(meetings): agendas follow their calendar event, nudge and notice no-shows (#2360)`.

### Task 11: Console — Start / Not right now, dashboard alert

**Files:**
- Modify: `apps/console/src/pages/setup/FinishSteps.tsx` (`StartStep`: two buttons; Start → `POST /api/setup/complete` then `POST /api/onboarding/start`, handling 409 `confirm_working_principal` with a confirm dialog listing signals; on success show the invitation link + copyable wording mentioning 48 hours (app route) or "Curia has said hello on <route>" (others) and, when `restartScheduled`, wait for `GET /api/system` `bootedAt` to change as Apply & restart does; "Not right now" → confirm dialog with the two wordings from design §3 by `setupFor`, then `POST /api/setup/complete` and go to `/`)
- Create: `apps/console/src/pages/dashboard/OnboardingAlert.tsx`; modify `apps/console/src/pages/DashboardPage.tsx` to render it when `GET /api/onboarding/status` says `showDashboardAlert`; its button runs the same start flow (extract the flow into `apps/console/src/pages/setup/start-onboarding.ts` and use it from both)
- Test: app tests beside the components (follow the existing `*.test.tsx` pattern in `apps/console`): Not right now shows the self vs other wording; alert hidden when `showDashboardAlert` false.

- [ ] **Step 1: Failing tests** as above. **Step 2:** run `pnpm -C <wt>/apps/console exec vitest run` → FAIL.
- [ ] **Step 3: Implement**, reusing `InvitePhonePanel` pieces for the link display where practical.
- [ ] **Step 4:** run → PASS; `pnpm -C <wt> run typecheck` → clean; `pnpm -C <wt>/apps/console run build` → succeeds.
- [ ] **Step 5: Commit** `feat(console): Start onboarding or Not right now, and a dashboard alert (#2360)`.

### Task 12: Scenario cases, spec 18, changelog

**Files:**
- Create scenario cases under `tests/scenarios/` following `tests/scenarios/README.md` and `docs/dev/behavior-tests.md` (deterministic checks first; stub web search): first conversation by chat (style → tone written; independence → 75; inbox expectations → triage released only after); deferral to a named day (books it, doesn't push); vague "later" (offers two times once); no-show wake (sends one "missed you"); side request mid-onboarding (separate task created, agenda resumed). **Do not run them.**
- Modify: `docs/specs/18-onboarding.md` (new "Layer 4 — Onboarding" section describing the flow per the design; Start step row updated: Start or Not right now, thread rotation at Start)
- Create: `changes/feat-2360-onboarding-program.md` (Added: **Onboarding program** — Curia researches, greets and onboards the principal by chat or voice (spec 18). Added: **Calendar-tied agendas** — follow moved events, nudge, and notice no-shows. Each ≤15 words after the dash.)
- Modify: `docs/wip/2026-11-20-onboarding-program-design.md` status → "Approved 2026-11-20; implementing".

- [ ] **Step 1:** write the cases; run only their static validation if the suite has one (e.g. a schema/lint test under `tests/unit` that loads cases) → PASS.
- [ ] **Step 2:** spec and changelog; `pnpm -C <wt> exec vitest run tests/unit/changelog-fragments.test.ts` → PASS.
- [ ] **Step 3: Commit** `docs(onboarding): spec 18, scenario cases and changelog (#2360)`.

### Final verification

- [ ] `pnpm -C <wt> run typecheck` clean; `pnpm -C <wt> run lint` clean; `pnpm -C <wt> exec vitest run tests/unit skills apps/console` pass (integration suite: run the onboarding-touching files only, on a fresh DB, and judge failures per the flaky-suite note).
- [ ] `pnpm -C <wt> exec tsup src/index.ts --format esm --no-dts` then `pnpm -C <wt> run check:dist-imports`.
- [ ] Whole-branch review (code review, silent-failure hunt, security review) weighed by `docs/dev/reviewing.md`; self-review against `docs/dev/review-checklist.md`.
