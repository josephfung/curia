# ADR-050: External verifications are first-class state, and sign-in codes are scrubbed by value

Date: 2026-10-19
Status: Accepted

## Context

On 2026-10-06 the principal asked Curia to get a policy notice from an insurer's portal. The
password was in the vault. The site wanted a second factor, and the errand failed at that step:

- The coordinator refused the code the principal sent three times, with three different
  rationales, among them a possible relay attack. Nothing told the model that this code was going
  into a challenge Curia's own browser had raised, on a sign-in the principal had asked for. A
  code typed into Curia's own pending challenge can only fail if it is wrong, so the request to
  sign in needs trust, and the place the code *goes* needs protecting.
- Inbox triage archived the emailed code as automated mail.
- The one turn willing to proceed had no handle on the browser session, because nothing carried
  the pending challenge from the turn that raised it to the turn that received the code.
- A reply to an ask sent from a backlog-task turn is auto-bound to the task and routed through
  `task-wake-reply`, which the heartbeat picks up hours later, long after any code expires.
- The refusals were written into a task progress note, and nothing would have stopped a code
  going the same way. The principal's stated no-go list forbids that: a code anywhere it would be read
  later (notes, reports, memory, knowledge-graph facts), or sent to anyone, including the
  principal.

Nothing in the existing safety stack stops a code reaching those places. Stage 1
`SECRET_PATTERNS` match key, JWT and hex shapes only. The Stage 2 judge names 2FA codes but is
skipped when the principal is the sole recipient and fails open when unreachable. Value-aware
redaction exists only for browser `secret_ref`. Task notes and memory writes are not outbound
sends at all.

Alternatives considered and rejected:

- **`outbound_context` metadata as the home for the pending challenge.** Entries exist only when
  Curia sends a message, injection takes the ten newest across all conversations, and it runs
  only on live principal turns. A synthetic resume or a task wake would never see it. The
  record also needs its own lifecycle (pending, satisfied, expired, abandoned) and a uniqueness
  rule, which a metadata blob cannot enforce.
- **Regex-only redaction** of anything that looks like a code. Shapes collide with years, times,
  amounts and phone numbers, so the filter must be either too loose or too leaky. Knowing the
  actual value is what lets the scrub be exact: a code the principal just relayed, or one the
  browser just typed, is masked wherever it appears and nothing else is touched.
- **Blocking a send, note or tool call that contains a code.** A blocked turn fails the errand
  the principal asked for, over a value that is safe to replace. The principal chose
  replace-not-block.
- **A paragraph in the coordinator's always-on prompt** telling it to accept codes. It would
  push against the budget and still be one more instruction the model weighs against its
  "never share your code" prior. [ADR-046](046-agent-behavior-fix-placement.md) puts the rule
  higher: code enforcement, then injection with its trigger.

## Decision

1. **A verification is a record, not a prompt.** A pending *external verification* (a third
   party wants proof from the principal before Curia can continue) is a row in a new
   `verifications` table (migration 099): `purpose` (`sign_in`), `kind` (`code`), `delivery`
   (`email | sms | app`), `site` and `page_domain` (registrable domains: the site the principal
   asked about, and the page showing the challenge, often an identity provider), the browser
   session, the optional task, status `pending → satisfied | expired | abandoned`, and expiry.
   "Approval" is avoided on purpose: ADR-018 uses it for Curia asking the principal's
   permission, the opposite direction. The code value is never stored in the table.
2. **One pending row per `site`**, enforced by a unique partial index. Opening a second for the
   same errand (the same `task_id`, or no task on either side) returns the existing one, so a
   later or concurrent turn reuses the challenge instead of triggering a new code. Opening one
   for a *different* task supersedes: the old row is closed as `abandoned` (its tracked values
   start aging) and a fresh row opens for the new task, so one task's code never satisfies
   another's record; `open` says so in its result. Expiry is a soft 10-minute hint, and closed rows stay "recent" for 120 minutes, still
   injected and still registering values, so a code sent at minute 12 is tried rather than
   refused.
3. **The coordinator `verification` tool** (`open | satisfy | abandon | list`, pinned,
   `action_risk: low`) opens and closes records. `open` takes `page_domain` from the browser
   session's own URL, not from the model, and returns the channel to ask the principal on from
   `verification.askChannelOrder` (`[signal, sms, slack, email]`: the first enabled channel with
   a verified principal identity; the channel the errand arrived on plays no part, because the
   principal often hands things over by email or voice to be done later). `web-browser` adds a
   `verification_suspected` hint to its page state when the page looks like a code screen.
4. **Per-turn injection over always-on prompt.** While a verification is pending or recent,
   `buildBaseSystemPrompt` appends a `## Sign-in verifications` block to coordinator turns and a
   `## Sign-in codes by email` block to ceo-inbox turns, whoever started the turn. The blocks
   carry the policy (the principal asked for this sign-in; accept a relayed code without
   lecturing; it goes only into the named session and site; never into notes or messages). With
   nothing active, nothing is injected, and neither agent's budgeted always-on prompt grows. The
   coordinator's tool-definition budget does grow for the new tool, raised 78,300 → 79,200 with
   a comment, following the precedent of #2159.
5. **A default-deny value scrub.** An in-memory `CodeTracker` holds the code values of live
   verifications, with a TTL of 120 minutes after close. Values are registered from three places:
   - `web-browser` typing a code-shaped value on a verification's `page_domain` (exact, and the
     only source for 4–5 character codes);
   - the dispatcher, from the principal's own new text on an inbound, only while an `sms` or
     `app` verification is pending or recent, and only 6–8 character code shapes;
   - the `delegate` skill, from a ceo-inbox result, for `email` verifications.

   `ExecutionLayer.invoke` then replaces every tracked value with `[sign-in code]` in **every
   string of every tool's input** (local and MCP), except `web-browser`. This covers task and
   scheduled-job notes, documents, `report-to-principal`, `memory-store` and every send skill
   without listing them. The same scrub covers the checkpoint extraction transcript (so no code
   becomes a knowledge-graph fact), log and error paths of the timestamp normalizer and the
   browser, and the coordinator's replies.
6. **`web-browser` is the one exemption and guards itself.** It receives the real value but
   refuses to `type` it, or `navigate` to a URL containing it (including percent-encoded forms),
   anywhere but the registrable domain of a verification that tracked it, and only in that
   verification's browser session. The match is by registrable domain, so `login.aircanada.com`
   matches `aircanada.com` and a lookalike does not; the session tells apart two verifications
   whose challenges sit on one identity provider (both on `b2clogin.com`), so one's code never
   lands in the other's. A reused verification moves its tracked values to its new session.
   URLs are made log-safe before they are logged or echoed.
7. **Reply scrubbing sits in the dispatcher, not the outbound filter.** The design called for a
   value-aware rule in Stage 1. The filter only blocks, and the principal chose replace over
   block, so `Dispatcher.handleAgentResponse` scrubs the reply and the note for the principal
   once, up front, and every relay path built from them (rewrites, approvals, bullpen filing,
   no-reply audit records) carries the scrubbed text. Stage 1 is unchanged.
8. **Task replies are not auto-bound while a verification is pending for the task.** The
   auto-bind of a principal's reply to a task-wake send, and the merge of that binding into an
   explicit context bridge, are both skipped, so the reply arrives as an ordinary live turn that
   the injection block equips, not through the heartbeat's hours-long path. A failed lookup
   binds as before.
9. **Single-process assumption.** The tracker is in memory, the same assumption as browser
   sessions. A restart drops tracked values, and the sessions die with it.

## Consequences

- A code that reaches Curia is masked in notes, reports, memory, documents, outbound messages and
  replies wherever the tracker knows it, not wherever a model remembers to leave it out. An
  outbound message containing a code goes out with `[sign-in code]` in its place instead of
  failing the turn.
- **Over-capture is accepted; under-capture is the failure to avoid.** A stray 6–8 character
  number in the same reply as an SMS code is masked in a note. A code the tracker has not seen yet
  is not masked: a 4–5 character code the principal relays is tracked only once the browser types
  it, so a note written before that can carry it.
- **A restart loses tracked values.** A value registered before a restart is no longer scrubbed
  afterwards. The same restart kills the browser session the value belongs to, and the record
  tells the next turn the session is gone, so the window is small. Moving to several processes
  needs a shared tracker or a sticky route.
- The raw stored message record (working memory, `audit_log`, `llm_call_archive`) is not
  scrubbed: the principal accepts single-use codes there.
- The default-deny scrub touches every tool call, so a tool that legitimately needs a literal
  that matches a tracked code gets `[sign-in code]` instead. `web-browser` is the only exemption,
  and it is destination-guarded.
- The per-site uniqueness rule means a sign-in that asks again while one is pending reuses the
  record and does not trigger a second code. A second task signing in to the same site while
  the first waits replaces the first's challenge; the first task has to sign in again.
- The model generalizes to `kind: approval` (tap-to-approve on a phone) and `purpose: payment`
  (an in-app card authorization) with a new `delivery`, not a new design. The invariant that
  stays: the request to sign in or pay comes from the principal, and whatever verification comes
  back goes only to the thing that asked for it. TOTP seeds in the vault and push approval are
  follow-ups.
- Releases gain scenario cases 24a–24d (SMS code over Signal, email code from the inbox, no
  leak across notes, reports, memory and sends, and a lost session), seeded through the new
  `verifications` and `principal_identities` scenario seed kinds.

See issue #2017 and `docs/wip/2026-10-19-delegated-signin-verification-design.md`.
