# Unauthenticated principal match: identity yes, authority no — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An inbound that resolves to the principal but whose channel did not authenticate the sender (email failing SPF/DKIM/DMARC, every SMS) is still recognised as the principal, but carries none of the principal's authority. Where that authority is needed, Curia asks for confirmation on an authenticated channel.

**Architecture:** `stampOriginator` keeps `systemRole: 'principal'` and stamps `authenticated: false`, and grants `liveTurn` only when authenticated. One predicate, `hasPrincipalAuthority(originator)` (`systemRole === 'principal' && authenticated === true`), backs `isPrincipalOriginated` and every raw `systemRole === 'principal'` authority check. The few read sites whose output only reaches the principal use a new `isPrincipalIdentity`. A migration makes `authenticated` explicit on every stored principal originator.

**Tech Stack:** TypeScript (ESM, Node 26), Vitest, PostgreSQL migrations (node-pg-migrate, plain SQL).

**Spec:** GHSA-p49r-jqh2-v668 (draft advisory), plus the maintainer's decisions on 2026-11-17 below.

## Decisions (maintainer, 2026-11-17)

- **Rule:** identity yes, authority no. An unauthenticated principal match is still treated as the principal in conversation, and ordinary work runs under the autonomy gates and the principal tier. It gets no `liveTurn` (no elevated skills, no principal-directed mailbox send, no backlog answers, no spot-check verdicts, no principal outbound-context block), no band-review principal or principal-task authority, no autonomy principal bypass, and no access to outbound entries beyond those sent to the principal. Reads stay on identity only where the result cannot leave the principal: an email reply goes to everyone on the thread, so another contact's calendar needs authority (ruled after the commit security review).
- **Channels:** Signal, Slack, web, console, console voice and Signal calls are unchanged. `cli` joins `inboundSenderAuthenticated` (only the principal has shell access). `smoke-test` does not (the smoke suite was removed).
- **Confirm, don't refuse (maintainer, 2026-11-17):** where the principal's authority is needed, Curia files an approval and delivers it on an authenticated channel, instead of refusing and asking the principal to repeat themselves. Approving replays the action, so nothing is retyped. An unexpected confirmation doubles as the spoofing alert.
  - Elevated tools, principal-mailbox sends (`ceo-inbox-send-draft`, `send-draft`) and `contact-link-identity` on an unauthenticated principal turn file a confirmation approval.
  - `approve-action`, `deny-action` or `dismiss-action` sent by SMS or unverified email re-sends that approval on an authenticated channel, noting that someone answered it from an unverified channel.
  - Held sends and autonomy escalations are already approvals; they only change where they are delivered.
  - Backlog answers by SMS are read as conversation and don't resolve backlog items. Any action they lead to goes through the gates above.
- **Approval delivery:** SMS is no longer an approval channel at all (an SMS "approve 3" can't approve anything now). An approval raised on an unauthenticated principal turn is marked `requester_unverified` and delivered only on Signal, Slack or the console (`web`). With none available it waits in the console and the digest.
- **Flood cap:** at most 3 unverified-request approvals delivered per rolling hour. Past the cap the approval waits in the digest, and the first refusal in a window sends one short notice on the same authenticated channel saying more are waiting.
- **Legacy originators:** `makePrincipalOriginator` and the two approval replays stamp `authenticated` explicitly. A migration backfills stored principal originators: `true` for protocol-authenticated channels, `false` for email and SMS (fail closed).
- **Finding for the advisory's first acceptance criterion:** no layer before `stampOriginator` refuses or downgrades a principal match. `ContactResolver.resolve` matches email and SMS by address alone (`resolveByChannelIdentity`). The email adapter publishes failing mail with `senderVerified: false`. Telnyx's signature authenticates the webhook, not the texter (ADR-036).

## Global Constraints

- `authenticated` is computed only by `inboundSenderAuthenticated` (and the voice caller-context transports). It is never read from inbound metadata.
- Fail closed: a principal originator whose `authenticated` is missing or not `true` has no authority.
- Do not bump versions. Add a changelog fragment `changes/fix-ghsa-p49r-principal-authenticated.md` under **Security**, each bullet at most 15 words after the em-dash.
- Commits are signed off with `-s` and carry no AI attribution.
- Run `pnpm -C <worktree> run typecheck` before every commit that touches `.ts`.
- Do not run paid scenario suites.

## Review Focus

1. An authenticated principal turn on Signal, Slack, web, CLI, console voice or a Signal call keeps `liveTurn`, the autonomy bypass and band principal authority. Pinned in Task 1 and Task 2.
2. Turn-lane drain: an authenticated live message drained into a host task whose originator is an unauthenticated principal must not upgrade the host. Pinned in Task 3.
3. A wake of a principal job stored before 2026-10-26 keeps its authority after the backfill when it came from Signal or console, and loses it when it came from email. Pinned in Task 6.
4. A reaction approval on a channel that does not authenticate (no metadata reaches the mapper) fails closed. Pinned in Task 1.
5. A principal email in a scenario case with no `sender_verified` still behaves as the principal (the harness defaults principal mail to verified). Pinned in Task 7.
6. A spoofed SMS asking for an elevated action produces exactly one confirmation on Signal, and a second identical SMS joins the pending one instead of pinging again. Pinned in Task 4.
7. A fourth unverified-request approval inside an hour is not delivered, and only one "more are waiting" notice goes out per window. Pinned in Task 5.

---

### Task 1: Core predicate, stamp and explicit originators

**Files:**
- Modify: `src/contacts/principal.ts` (add `hasPrincipalAuthority`, `isPrincipalIdentity`; `isPrincipalOriginated` delegates; `makePrincipalOriginator` sets `authenticated: true`)
- Modify: `src/contacts/stamp-originator.ts` (`liveTurn = originator.systemRole === 'principal' && input.authenticated`; fix the stale "voice always passes false" doc)
- Modify: `src/dispatch/outbound-entry-access.ts` (`'cli'` authenticated; `outsiderOriginatorContactId` returns the contact id for an unauthenticated principal)
- Modify: `src/dashboard/console-approval.ts:246` (`authenticated: true`)
- Modify: `src/autonomy/reaction-approval-mapper.ts:401` (`authenticated: inboundSenderAuthenticated(channelId, undefined)`, `tier: 'principal'`)
- Test: `tests/unit/contacts/stamp-originator.test.ts`, `tests/unit/contacts/principal.test.ts`, `tests/unit/dispatch/outbound-entry-access.test.ts`, the reaction-approval mapper test

**Interfaces:**
- Produces: `hasPrincipalAuthority(originator: TaskOriginator | null | undefined): boolean`. `isPrincipalIdentity(metadata: Record<string, unknown> | undefined): boolean` (the old `isPrincipalOriginated` body). `isPrincipalOriginated(metadata)` is `hasPrincipalAuthority(metadata?.originator)`.

- [ ] **Step 1: Failing tests.** stampOriginator: a principal sender context with `authenticated: false` on `email` and on `sms` gives `liveTurn === false`, `originator.systemRole === 'principal'` and `originator.authenticated === false`. With `authenticated: true` (`signal`, `email`, `voice`) it gives `liveTurn === true`. principal.ts: `isPrincipalOriginated` is false for `{ systemRole: 'principal', authenticated: false }` and for a missing `authenticated`, and true for `authenticated: true`. `isPrincipalIdentity` is true for all three. `makePrincipalOriginator(...).authenticated === true`. outbound-entry-access: `inboundSenderAuthenticated('cli', undefined)` is true and `('smoke-test', undefined)` is false. `outsiderOriginatorContactId({ originator: { systemRole: 'principal', authenticated: false, contactId: 'p1', … } })` returns `'p1'`, and returns `null` for `authenticated: true`. Reaction mapper: an `email` decider replays with `liveTurn: true` but an originator that has `authenticated: false`.
- [ ] **Step 2:** Run `pnpm -C <wt> exec vitest run <those files>`. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement the changes listed under Files.
- [ ] **Step 4:** Run the same files. Expected: PASS.
- [ ] **Step 5: Fixture fallout.** Run `pnpm -C <wt> exec vitest run tests/unit skills` (unit only; the integration suite needs Postgres). For each failure caused by a principal-originator fixture without `authenticated`, add `authenticated: true` to that fixture (that is what the test always meant). A failure that is not fixture-shaped is a real finding: stop and report it. List the touched fixtures in the commit body.
- [ ] **Step 6:** Typecheck, then commit `fix(auth): principal authority requires an authenticated inbound (GHSA-p49r-jqh2-v668)`.

### Task 2: Band send review authority

**Files:**
- Modify: `src/dispatch/band-send-review.ts:714-728` (`authorityOf`), `:1186-1205` (`askTaskTitle`, `linkToPrincipalTask`), and the header comment at `:50-55`
- Test: `tests/unit/dispatch/band-send-review.test.ts`

**Interfaces:**
- Consumes: `hasPrincipalAuthority` (Task 1).

- [ ] **Step 1: Failing tests.** A directed disclosure ruling on a send whose drafting originator is `{ systemRole: 'principal', authenticated: false, channel: 'email' }` resolves `authority: 'none'` and does not send (hold or bounce, per the existing unsupported path). The same with `channel: 'sms'`. A bound task whose originator is an unauthenticated principal gives no `principal-task` authority. A strong link to such a task gives none either. The authenticated principal (`signal`, and `email` with `authenticated: true`) still sends a directed item.
- [ ] **Step 2:** Run the file. Expected: the new cases FAIL.
- [ ] **Step 3:** Replace each originator `systemRole === 'principal'` authority test with `hasPrincipalAuthority(...)`. Update the comment at `:720-722`, which claims the role alone is trusted.
- [ ] **Step 4:** Run the file. Expected: PASS.
- [ ] **Step 5:** Typecheck, then commit.

### Task 3: Dispatcher and remaining authority sites

**Files:**
- Modify: `src/dispatch/dispatcher.ts:492` (drained-lane upgrade: `hasPrincipalAuthority(routing.originator)`)
- Modify: `src/dispatch/dispatcher.ts:1128` (relayed-code tracking runs on `originator.systemRole === 'principal'`, not on `liveTurn`; it only scrubs, and the principal's real SMS codes must stay scrubbed)
- Modify: `src/dispatch/dispatcher.ts:1328` (outreach linking skips any principal-identity originator, not just `liveTurn`)
- Modify: `src/dispatch/task-outreach-capability.ts:189` (`confirmed` needs `hasPrincipalAuthority`)
- Modify: `skills/calendar/tools/calendar-list-events/handler.ts:108`, `src/skills/_shared/calendar-identity-guard.ts:44` (use `isPrincipalIdentity`; output reaches only the principal, and the guard stays on)
- Test: the matching unit tests under `tests/unit/dispatch/`, plus `skills/calendar/tools/calendar-list-events/handler.test.ts`

- [ ] **Step 1: Failing tests.**
  - The turn-lane drain of a `liveTurn: true` input into a host whose originator is an unauthenticated principal leaves `routing.liveTurn` unset.
  - A principal SMS carrying a sign-in code is still tracked (the scrub runs) and still gets `liveTurn: false`.
  - A forged principal email that replies to outreach gets no `linkedTask`.
  - Outreach `confirmed` is false for an unauthenticated principal scope.
  - calendar-list-events still allows a `contactId` override for an unauthenticated principal.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Typecheck, then commit.

### Task 4: Confirm on an authenticated channel instead of refusing

**Files:**
- Modify: `src/contacts/principal.ts` (add `isUnauthenticatedPrincipal(metadata): boolean`, which is identity and not authority)
- Modify: `src/skills/execution.ts`:
  - The elevated gate (`:2461`): on an unauthenticated principal turn that is not a wake, for any tool outside `APPROVAL_RESOLUTION_TOOLS`, return `buildElevatedConfirmationError` with a `reason` variant.
  - For `APPROVAL_RESOLUTION_TOOLS`, call `approvalDelivery.redeliverForVerification(ref)` and return an advisory instead.
  - New pre-handler check: `UNVERIFIED_CONFIRM_TOOLS = new Set(['ceo-inbox-send-draft', 'send-draft', 'contact-link-identity'])` on an unauthenticated principal turn files the same confirmation.
  - Every `approvalTrigger.request` call passes `requesterUnverified: isUnauthenticatedPrincipal(options?.taskMetadata)`.
- Modify: `src/autonomy/approval-trigger.ts` (`request` opts gain `requesterUnverified?: boolean`, stored on the row)
- Modify: `src/agents/prompts/sender-line.ts`, `src/agents/runtime.ts:1447` (sender facts add `UNAUTHENTICATED_PRINCIPAL_LINE` on the triggering turn only)
- Modify: `src/index.ts` (wire `approvalDelivery` into the execution layer)
- Test: `tests/unit/skills/execution-elevated-unverified.test.ts` (new), `tests/unit/agents/prompts/sender-line.test.ts`

**Interfaces:**
- Consumes: `hasPrincipalAuthority`, `isPrincipalIdentity` (Task 1). `ApprovalDelivery.redeliverForVerification(shortRefOrNumber: string): Promise<DeliverResult>` (Task 5).
- Produces: `isUnauthenticatedPrincipal(metadata)`. Approval rows with `requesterUnverified: true`.

Exact copy:
- Approval reason: `This request came from your {SMS number | email address}, but that channel can't prove you sent it. Approve only if it was you. If it wasn't, deny it: someone may be impersonating you.`
- `UNAUTHENTICATED_PRINCIPAL_LINE`: `This message matches the principal's address, but its channel did not prove they sent it. Help as usual. Actions that need the principal's authority are sent to them for confirmation on a verified channel. When that happens, tell them a confirmation is waiting; don't ask them to repeat the request.`
- Redeliver preamble: `Someone answered approval {n} from your {SMS number | email address}, which can't be verified. If that was you, approve it here.`

- [ ] **Step 1: Failing tests.**
  - An elevated tool (`contact-set-tier`) on an `sms` principal turn returns the confirmation advisory, and the approval row has `requesterUnverified: true` with the reason copy.
  - The same call on an authenticated Signal turn runs.
  - `approve-action` on an `sms` principal turn does not resolve the approval; it calls `redeliverForVerification` with the ref.
  - `send-draft` on an unverified email principal turn files a confirmation, and replaying it with `humanApproved` runs the handler.
  - A repeat of the same elevated call joins the pending approval ("already pending").
  - The sender-line test covers the new line: present for `sms` and for unverified email, absent for `authenticated: true`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `tests/unit/agents/prompt-budget.test.ts`. Expected: PASS.
- [ ] **Step 5:** Typecheck, then commit.

### Task 5: Authenticated-only approval delivery and the flood cap

**Files:**
- Create: `src/db/migrations/128_action_log_requester_unverified.sql` (`ALTER TABLE autonomy_action_log ADD COLUMN requester_unverified BOOLEAN NOT NULL DEFAULT false`)
- Modify: `src/autonomy/action-log-types.ts`, `src/autonomy/action-log-repo.ts` (`requesterUnverified` on rows and inserts; `countUnverifiedDeliveredSince(since: Date): Promise<number>`)
- Modify: `src/autonomy/approval-delivery.ts`:
  - `APPROVAL_CHANNELS` drops `'sms'`.
  - `VERIFIED_APPROVAL_CHANNELS = ['signal', 'slack', 'web']`.
  - `deliver()` limits a `requesterUnverified` row to those channels and enforces the cap (`reason: 'rate_limited'`, with one notice per window).
  - New `redeliverForVerification`.
- Modify: `skills/autonomy/tools/deliver-approval/tool.json` (description drops SMS from the order and says unverified requests go only to Signal, Slack or the phone app); `skills/autonomy/tools/deliver-approval/handler.ts` (on `rate_limited`, tell the agent it waits in the digest and not to retry)
- Test: `tests/unit/autonomy/approval-delivery.test.ts`, the deliver-approval handler test, and the expiry-sweep test (the safety net honours both rules)

- [ ] **Step 1: Failing tests.**
  - `availableChannels()` never includes `sms`.
  - A `requesterUnverified` row asked for on `email` returns `channel_unavailable`, with `available` limited to Signal, Slack and web.
  - With 3 unverified deliveries in the last hour, a 4th returns `rate_limited` and sends one notice. A 5th returns `rate_limited` and sends no second notice.
  - An unflagged row is unaffected by the cap.
  - `redeliverForVerification` sends an already-delivered approval again on the first verified channel, with the preamble. With no verified channel it returns `channel_unavailable`.
  - The expiry sweep never picks `sms` and honours `rate_limited`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the in-memory notice-window state bounded like `displays`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Typecheck, then commit.

### Task 6: Backfill stored principal originators

**Files:**
- Create: `src/db/migrations/127_principal_originator_authenticated.sql` (check `ls src/db/migrations | sort` for a free prefix after any rebase)
- Test: `tests/integration/db/principal-originator-authenticated-migration.test.ts`

Tables and columns: `scheduled_jobs.originator`, `tasks.originator`, `bullpen_threads.originator`, `pending_delegations.originator`, the secret-capture routing table's `originator` (migration 054), and `task_outreach.originator`. For rows where `originator->>'systemRole' = 'principal'`:
- If `authenticated` is missing, set it to `true` when `originator->>'channel'` is in `('signal','slack','web','console','cli','voice')`, and `false` otherwise.
- Also set `voice` rows to `true` when `authenticated` is `false`: #2312 stamped every voice originator `false` until 2026-11-16, and production has had no voice transport except console and Signal calls.

Write one `UPDATE … SET originator = jsonb_set(...)` per table. The down migration is a no-op with a comment (the old values were absent, not recorded).

- [ ] **Step 1: Failing integration test.** Seed one principal row per case (signal/missing, email/missing, sms/missing, voice/false, email/true, plus a `trusted` non-principal row). After the migration: signal → `true`, email → `false`, sms → `false`, voice → `true`, email/true unchanged, non-principal row untouched.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 7: Scenario harness default, specs, changelog

**Files:**
- Modify: `tests/scenarios/harness.ts:918` and the inbound-publish path (a principal `email` inbound defaults `senderVerified` to `true` unless the case sets `sender_verified: false`); `tests/scenarios/README.md` (document the default)
- Modify: `docs/specs/14-autonomy-engine.md` (principal bypass needs an authenticated originator; unverified requests are confirmed, not refused), `docs/specs/15-outbound-safety.md` (band review principal authority needs `authenticated === true`; the identity-yes, authority-no rule and its channel table; approvals never go by SMS; unverified-request approvals go to verified channels only, capped at 3 an hour)
- Create: `changes/fix-ghsa-p49r-principal-authenticated.md`
- Test: the scenario loader/harness unit tests if any cover inbound metadata; otherwise `pnpm -C <wt> exec tsx tests/scenarios/cli.ts --dry-run` (or the loader's validate mode), which costs nothing

- [ ] **Step 1:** Implement the harness default and the README line. Run the free validation. Expected: all cases load.
- [ ] **Step 2:** Edit specs 14 and 15 and write the fragment. Run `pnpm -C <wt> exec vitest run tests/unit/changelog-fragments.test.ts`. Expected: PASS.
- [ ] **Step 3:** Run the full unit suite and typecheck. Expected: green.
- [ ] **Step 4:** Commit.

### Finish

Pre-PR passes, each given `docs/dev/reviewing.md`: own review against `docs/dev/review-checklist.md`, a silent-failure hunt and a security review. Then open a public PR with the `no-loop` label that references GHSA-p49r-jqh2-v668. Record the advisory's first finding (the Decisions section) on the draft advisory once the maintainer okays editing it.
