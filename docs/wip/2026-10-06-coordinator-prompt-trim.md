# Coordinator always-on prompt: trim to the 4k target and past it (plan)

Part of #1954. This plan closes the epic's last open acceptance criterion: the YAML
`system_prompt` must be at most 4k tokens under the CI budget. It then keeps going as far as
the behavior runs allow. The final phase carries the same lessons to the specialist prompts in
curia and curia-deploy. The placement rule is [ADR-046](../adr/046-agent-behavior-fix-placement.md).
Sizes and behavior runs are recorded in the [baseline log](2026-10-01-coordinator-context-baseline.md).

This document is planning only. Each PR below gets its own branch and is A/B'd against
`origin/main`'s prompt before merge.

## Status

Updated as each PR lands. Measurements and behavior runs for each PR are in the baseline
log.

| PR | State | YAML `system_prompt` | Always-on (est. tokens) / CI budget |
|---|---|---:|---:|
| Start (`3155f290`) | — | 20,532 | ~6,673 / 7,000 |
| 1: restatements and stale sections | In review (2026-10-07) | 18,561 | ~6,180 / 6,400 |
| 2–10, final phase | Not started | — | — |

**PR 1 (2026-10-07).** Deleted Data protection, Reporting's second paragraph, "Decide,
don't drop", Addresses and accounts, Low-trust senders, the roster pointer, "When a
request requires specialized expertise…" (the `delegate` description says it) and the
casual-messages style line. Channel ownership became one clause on the transfer-ownership
item. The "My team" heading went too (review): its `context_bridge` paragraph now sits
under the transfer-ownership reply rule, as the sending half of that contract. The stale
`contact-update` pin comment was fixed. The "ask when an export's scope is unclear"
judgment moved to the export section of the google-workspace `drive-files.md` reference,
which loads with every Drive or Sheets export. Spec 06 no longer quotes the deleted
directives. `loader.test.ts` gained four "does not restate" rows instead of the
`**Channel ownership.**` assertion.

Behavior held:
- **Scenarios:** every case passed on behavior. The only gate failure was an unstubbed
  `inspect_doc_structure` call in `google file filing after delegation`, which also
  happens on main's prompt. PR 1 also closes that hole. Case 13a now stubs every lookup
  the coordinator reached for, and 10 runs then made no refused calls.
- **Smoke:** 44 of 46. Both failures passed 4 of 4 rounds on each side in the A/B.

### Lessons so far

These apply to every later PR and to the final phase. They are also posted on #2025 and
curia-deploy#276.

1. **Rules outlive their causes.** The acting-as rule (April) was written for
   workspace-mcp's `user_google_email`. Code fixed that in May, and the text stayed for
   five more months. For each rule, `git log -S` its first line, then check whether a later
   code change already handles the cause.
2. **Prompts and pin comments drift from the toolset.** The coordinator named two tools it
   doesn't pin. A pin comment claimed `contact-update` promotes low-trust senders; the tool
   has no tier field, and the capability lives in the contacts specialist's
   `contact-set-tier`. Cross-check every tool a prompt names against the agent's resolved
   pins.
3. **"Enforced in code" needs reading the enforcement point.** The reply-lock suppresses
   only the final relay. The NO_REPLY backstop only catches narration that contains the
   token. Where enforcement is partial, keep one clause rather than the paragraph.
4. **Specs quote prompt text.** Spec 06 quoted the deleted Data protection lines word for
   word. Grep `docs/specs/` before deleting.
5. **Guard deletions with the "does not restate" table** in `loader.test.ts`, not with
   assertions on the remaining prose. Each row names where the rule now lives.
6. **A full-suite miss is not a regression until the A/B says so.** All five
   below-threshold results in PR 1's full runs either recurred on main's prompt or
   disappeared on rerun. That matches #1958–#2024. Budget a targeted A/B (about 30 minutes,
   under $2) into every PR rather than reading a single red run.

## Goal

| Measure | Today (`3155f290`) | Epic target | This plan |
|---|---:|---:|---:|
| YAML `system_prompt` | 20,532 chars (~5.1k tokens) | ≤ 16,000 chars (4k tokens) | ~6–7k chars (~1.6k tokens) |
| Always-on budget: YAML + pinned SKILL.md (`prompt-budget.test.ts`) | ~6.7k tokens (budget 7,000) | — | ≤ ~3k tokens |
| Prohibitions in the YAML | 33 ("never" ×19, "do not" ×14), with negation in 54 of 139 sentences | — | a few, none quoting the unwanted output |

The behavior bar does not move: no critical scenario behavior and no smoke case may regress
on the production standard-tier model (`deepseek/deepseek-v4.1-flash`).

Size is the part we can measure, but it isn't the main payoff. The coordinator's prefix is
cached, and a cache read costs about 2% of the uncached input price, so cuts barely move
cost. The payoff is fewer rules to weigh at once:

- The same rule appears in several places, worded differently.
- Absolutes contradict each other.
- Examples of what not to say put those exact strings into the context.

## Principles for every PR in this plan

1. **One rule, one place.** Before adding text anywhere, delete every other statement of it
   (ADR-046).
2. **Say what to do.** Write positive instructions. Don't quote examples of unwanted output:
   `not "I can use the web-fetch tool"` puts the tool name into the context. Drop
   capitals and labels like "(mandatory)" and "(do not violate)". The in-house evidence is
   #1990: pointing the model at a place for the note worked, and the prohibition ("add no
   note") did not.
3. **Policy goes in the YAML; personality goes in the identity block.**
   - The YAML says who gets what information, keeps one first-person voice, keeps
     internals out, and says whose instructions count.
   - Warmth, formality, length, directness and how readily to ask questions belong to the
     office identity, which the principal edits in the console's Personality settings.
   - YAML text that sets any of these overrides the principal's own settings.
4. **Move text to turn guidance only when it has a trigger.** Turn guidance rides in the
   uncached user message. Moving text that applies on every turn there costs more, not less.
5. **Move the test with the rule** (ADR-046, "Tests for prompt text"). Replace unit tests
   that pin prompt text with tests of the mechanism that now carries the rule.
6. **A/B every cut on the same day** against `origin/main`'s YAML. In #1958, deleting a
   whole passage removed a judgment that scenario case 10 relied on, and only the A/B
   caught it.
7. **Lower the budget** in `tests/unit/agents/prompt-budget.test.ts` in every PR that
   shrinks the prompt. Record the new size in the baseline log.

## Findings

Measured on `3155f290`. "Rung" is the destination under ADR-046.

| Section (chars) | Finding | Evidence | Rung / action |
|---|---|---|---|
| My team: Channel ownership (387) | Partly enforced in code | The reply-lock suppresses the coordinator's final relay once a human-facing send has reached the sender, and files it on the bullpen (`src/dispatch/reply-lock.ts`, `dispatcher.ts` `handleAgentResponse`, #1860). An extra send the coordinator makes itself is not blocked. | Replace with one clause in the transfer-ownership item |
| Data protection (329) | Mostly enforced in code | `src/security/export-controls.ts` covers email attachments and Google Workspace MCP exports (item threshold, destination allowlist, restricted block). Stage 2.5 gates disclosure in prose, and the security block sets a data-export threshold. The "ask when the scope is unclear" judgment has no code behind it. | 1: delete; the scope judgment moves to the export section of `drive-files.md` (rung 4, loads with every export) |
| Reporting, second paragraph (265) | Duplicate | Every `<task_error>` carries the same rule and both exceptions (`src/errors/classify.ts`, #1546) | 2: delete |
| Scheduling: "Decide, don't drop" (155) | Duplicate | `skills/tasks/SKILL.md` states the same rule in different words | Delete |
| NO_REPLY: "Do not narrate that decision…" | Partly enforced in code | A body containing a standalone NO_REPLY is treated as a decline (`src/dispatch/no-reply.ts`); auto-generated mail never relays. Narration without the token still sends. | 2: fold into the non-principal guidance (PR 4) |
| Addresses and accounts (329) | Stale | See Decisions. `entity-context` is a standalone tool the coordinator does not pin; it can reach it only through discovery. | Delete |
| Low-trust senders (203) | Stale | `contact-register` is not pinned. `contact-update` is pinned, but neither tool can set a tier: `contact-update` has no tier or trust field, and `contact-register`'s description says elevation is not its job. The pin comment saying `contact-update` "promotes a confirmed low-trust sender" is stale too. | Delete and fix the pin comment. Promotion already works: the contacts specialist's `contact-set-tier` handles "treat X as trusted", reached by delegating to it |
| Calendar (742, plus 184 in Handle directly) | Mostly enforced in code | Calendar tools are restricted to other agents with `allowed_callers` (#1958) | Keep the routing line and the failure line |
| "Resolve people through the contacts specialist" | Stated five times (~2,530) | My identity, Contact intelligence, Before composing, Addresses, Storing facts | Merge into one People section |
| "No internals" and voice | Stated four times (~2,090) | Who I am, Outbound voice, "NEVER expose…", the task-mechanics bullet | Merge into Who I am |
| Non-principal rules (~1,760) | Apply only on non-principal turns | NO_REPLY, "final response is the message they receive", and the two separate sends. The dispatcher already adds `non-principal-reply-shaped` on every such turn except auto-generated mail, whose own preamble already covers NO_REPLY (`src/dispatch/turn-guidance-triggers.ts`). | 2: turn guidance |
| How to determine the audience (505) | Teaches the model to parse a line that code could state directly | `Current sender: … (principal)` in `src/agents/runtime.ts` | 2: the sender line states the audience |
| Lower-trust channel bullet (241) | Matters only when a permission is blocked by channel trust | The AUTHORIZATION "Blocked by channel trust" line | 2: move there |
| Transfer-ownership reply rule (732) | Matters only when an [ACTIVE OUTBOUND CONTEXT] block is present, and only principal turns get one | The `outbound-context` turn guidance already cites the rule by name | 2: move into that guidance; keep a one-line anchor |
| Provenance (970) | Overlaps the security block's Prompt Injection Defense | `src/security/security-context.ts`; red-team suite #900 | Compress, preferably merge with that section |
| Style lines | Override identity settings | "keep responses concise unless detail is requested" duplicates the default behavioral preference. "Naturally and warmly" duplicates the default tone. "Concise and professional", "professional and competent" and "ask clarifying questions freely" conflict with settings; the last also conflicts with "Own the how" in the tasks SKILL.md. | Delete; keep the disclosure rule as policy |
| "Sign emails professionally…" (86) | The setting it covers for does nothing | `assistant.emailSignature` (console Wizard and Personality settings) reaches `agentPersona`, but nothing reads it | 1: apply in code; delete the line |
| Inbox: the `email-draft-save` sentence (167) | Prose only | The handler only warns when `account` is omitted | 1: refuse the principal's account when the coordinator calls it |
| Google Workspace: the web-fetch sentence (207) | Prose only | No URL guard in `web-fetch` / `web-browser` | 1: refuse Google URLs and point to `skill-activate` |
| Memory, Configuration, Scheduling (~4,150) | Mostly restate tool descriptions | `config-store`, `scheduler-create` / `scheduler-update` and `memory-store` descriptions | 3: tighten; move the query, owner and task-list hints into descriptions |
| What I proactively surface (1,075) | Teaches the model to go and look | — | 2: inject a backlog line on principal turns |
| Per-specialist routing (inbox, calendar) | The roster descriptions are operational, not about routing | ceo-inbox's roster entry is 668 chars, mostly about its 15-minute triage | Add a routing field to the roster |
| SKILL.md bodies: `tasks` (3,474), `documents` (2,679) | Much of it applies only on wakes | The Placement paragraph is already injected on wakes (`src/agents/document-placement.ts`) | 2: inject at wake time |

## Decisions (2026-10-06)

- **How far to go.** As far as the A/B runs allow. Every PR below is in scope.
- **Delete the whole "Addresses and accounts" section, including the acting-as exception.**
  - **Origin.** It came from `2b7f5daf` (2026-04-11). workspace-mcp's `user_google_email`
    parameter was being filled with the principal's address, which started an OAuth flow on
    every call.
  - **The cause is now handled in code.** Since `719ee2a9` (2026-05-08) the MCP loader
    strips that parameter from the schema and fills it from the vault (`fixed_input:
    user_google_email` in `config/skills.yaml`; `stripFixedInputsFromSchema` and
    `mergeFixedInputs` in `src/skills/mcp-loader.ts`). Fixed values override anything the
    model passes.
  - **The general rule already lives in an injected block.** The `## Your Contact Details`
    intro (#387) says "never substitute the principal's details". The leftover exception
    only invites the thing that rule forbids.
  - **The section's first sentence is stale too.** It names `entity-context`, which the
    coordinator doesn't pin.
- **Travel preferences live in `config-store`.**
  - **The split.** `config-store` owns the principal's own standing settings: company,
    meeting links, travel preferences and loyalty programs. Memory owns facts about people,
    organizations and things.
  - **Why `config-store`.** Its description already documents those namespaces and their
    key conventions. Its facts are `decayClass: permanent`, and lookup is exact. A
    `memory-query` search finds config values only through an embedding of the bare key
    label.
  - **Prompt change.** The memory section's examples ("preferred airline", "standing travel
    preferences") become examples about people.
  - **Alternatives considered.** Keeping everything in memory: decay could archive standing
    preferences, and key labels recall poorly. Merging the two tools: a larger change that
    loses exact lookup.
- **The email signature is applied in code,** not described in the prompt.

## PR sequence

Sizes are estimates: drafted rewrites (see the appendix) plus measured paragraphs. Each
PR's A/B decides whether its cuts stay.

| PR | Scope | YAML after (est.) |
|---|---|---:|
| 1 | Delete restated code rules and stale sections | ~18.6k |
| 2 | Consolidate the People, Who I am and calendar text | ~15.3k (meets the epic target) |
| 3 | Rewrite pass: positive phrasing, style text out, tighter direct-capability sections | ~11.1k |
| 4 | Audience in code: sender line, non-principal turn guidance, reply rule, provenance | ~7.6k |
| 5 | Principal note block on the relay | ~7.6k (the turn guidance shrinks) |
| 6 | Move prose-only rules into code | ~7.0k |
| 7 | Backlog line for proactive surfacing | ~6.7k |
| 8 | Routing-oriented roster | ~6.1k (roster −~1k) |
| 9 | Wake-only SKILL.md content moves to wake-time injection | SKILL.md −~3k |
| 10 | Negation pass on the injected blocks | — |
| Final phase | The same lessons applied to the specialist prompts in curia and curia-deploy | — |

### PR 1: delete restated code rules and stale sections

YAML-only changes:

- **Delete** Data protection, Reporting's second paragraph, "Decide, don't drop",
  Addresses and accounts, and Low-trust senders.
- **Delete** the roster pointer at the top of My team.
- **Delete** "For casual messages, respond naturally and warmly; keep responses concise
  unless detail is requested".
- **Replace** the Channel ownership paragraph with one clause on the transfer-ownership
  item: "their send is the one message the person gets".
- **Fix** the stale pin comment that says `contact-update` promotes a confirmed low-trust
  sender.

Then:

- **Tests:** `tests/unit/agents/loader.test.ts` expects `**Channel ownership.**`. The
  reply-lock already has its own tests (`tests/integration/dispatcher-reply-lock.test.ts`),
  so drop that assertion.
- **Verify:** full scenarios and smoke, as an A/B. Watch 08 and the smoke case
  "Coordinator routes long-running task with synchronous acknowledgment".
- **Risk:** low. Everything removed is either enforced in code, repeated elsewhere, or
  names a tool the coordinator doesn't pin.

### PR 2: consolidate

Changes:

- **People:** one section (draft A) replaces My identity, Contact intelligence, Email with
  Before composing, and the person-resolution part of Storing facts. It also resolves the
  contradiction "the ONLY contact ID I should EVER use directly" vs "use the ID from
  `<resolved_entities>`".
- **Who I am:** merge the four voice and no-internals statements (draft B), with no
  quoted anti-examples. Keep a one-line signing instruction until PR 6 applies the
  configured signature in code.
- **Calendar:** drop the Handle-directly clause and "I never read or mutate…", which code
  enforces. Keep the routing line and the failure line.

Then:

- **Tests:**
  - `coordinator-calendar-routing.test.ts` slices the prompt by heading and pins phrases.
    Keep its `allowed_callers` and pin assertions; drop the text slices.
  - `coordinator-cold-compose.test.ts` pins the cold-compose sentence. Keep that sentence
    word for word, or move the test to the behavior.
  - `loader.test.ts` (#1958 block) expects `NEVER name tools, systems` and "more than one
    agent was involved" exactly once. Draft B drops both, so update or remove those counts.
- **Verify:**
  - Scenarios 09, 10 and 12.
  - Smoke contact cases: Ambiguous Contact Reference, Contact Briefing Delegation, and
    Role/Person Mismatch.
  - Smoke Draft Email in CEO Voice, and the calendar cases.
- **Budget:** lower it. This PR meets the epic's 4k-token acceptance criterion.

### PR 3: rewrite pass

Changes:

- **Negatives:** every remaining negative becomes a positive instruction. Capitals and
  emphasis labels go.
- **Style text:** delete "Be professional and competent", "Keep email responses concise and
  professional" and "Ask clarifying questions freely". "Be candid…" becomes a disclosure
  rule: the principal gets everything I know and the current state of things.
- **Tighten these sections:**
  - Tasks and routines (draft C).
  - Memory and Configuration, using the config-store/memory split above.
  - Delegation acknowledgment (~230 chars) and Proactive surfacing (~550).
  - Inbox: keep the sentence that `coordinator-cold-compose.test.ts` pins.
  - Google Workspace and Capability discovery.
- **Move hints into tool descriptions (rung 3).** The local tool definitions have about
  2.3 KB of headroom under the 77,000-byte budget, so these must fit. The 74,856-byte
  figure predates `approval-expiry-sweep` being unpinned; re-measure first.
  - `memory-query` `query`: use descriptive queries, not bare names.
  - `task-create` `owner`: what ceo, curia and external mean.
  - `task-list`: call it before answering "what's open".

  Each changed `tool.json` gets a version bump.

Then:

- **Verify:** scenarios 05a–c and 13a–f. Smoke Store and Recall Travel Preferences, Store
  and Recall Company Info, Meeting Link Storage and Lookup, Tracking Third-Party Promises,
  and Natural Language Deadlines.

### PR 4: audience in code

Changes:

- **The sender line states the audience.** `(principal)` stays. A non-principal sender gets
  something like "not the principal; your final response is sent to them". CLI resolves
  to the principal as it does today. "How to determine the audience" is deleted. Two cases
  need care in `src/agents/runtime.ts`:
  - An unresolved sender gets no `Current sender` line; it gets the LOW-TRUST block.
  - A non-principal's descriptive role renders in the same parentheses as `(principal)`.

  The audience wording has to be unambiguous in both cases.
- **Non-principal rules move into turn guidance.**
  - NO_REPLY (including the narration point, phrased as "exactly NO_REPLY and nothing
    else"), "final response is the message they receive" and the two-separate-sends rule
    go into the `non-principal-reply-shaped` block (draft D).
  - "Never use NO_REPLY with the principal" goes too: principal turns no longer see
    NO_REPLY at all.
- **The lower-trust channel bullet** moves to the AUTHORIZATION "Blocked by channel trust"
  line, rendered only for the principal.
- **The transfer-ownership reply rule** moves into the `outbound-context` guidance, and a
  one-line anchor stays in the routing decision.
  - Check first that no non-principal path still carries a delegation hint. The rule's
    "external party" clause suggests one once did.
- **Provenance** compresses to about 390 chars. Ideally it merges with the security
  block's Prompt Injection Defense, so the two injection rules become one.

Then:

- **Exfiltration markers:** turn guidance is covered automatically (`TURN_GUIDANCE_TEXTS`).
  New text in the sender line or the security block is not, so decide whether it needs to be.
- **Tests:**
  - `tests/unit/agents/prompts/trigger-guidance.test.ts` caps all turn guidance rendered
    together at 6,000 chars. Today it is about 5.5k, and draft D plus the reply rule push
    it over. Compress first. If the cap still has to move, restate it as the worst case of
    one real turn: `non-principal-reply-shaped` and `outbound-context` never appear
    together. Say why in the PR.
  - `loader.test.ts` expects `return exactly \`NO_REPLY\`` and `is **always**
    transfer-ownership` once each. Both move out of the YAML here.
  - Scenario 11's header comment cites "The transfer-ownership reply rule".
- **Verify:** scenarios 01a–c, 02a–b, 03a–b, 04a–b, 07, 10 and 11, plus
  `pnpm redteam:provenance:external` and `pnpm redteam:provenance:principal` (#900).
- **Risk:** the highest in this plan, because this is the core routing contract.

### PR 5: principal note block on the relay

Today, on a non-principal turn, the dispatcher sends the coordinator's final response
unchanged (`src/dispatch/dispatcher.ts`, `handleAgentResponse`). The `<reply>` /
`<note_for_principal>` blocks exist only on the delegation-failure path
(`src/agents/delegation-failure-reply.ts`, #1860, #1978, #1990).

Changes:

- **Split the relay.** On non-principal relays, cut `<note_for_principal>` out of the final
  response and deliver it to the principal; the rest is the reply.
- **Untagged output stays the whole reply,** so a missed tag behaves exactly as today.
- **Reuse the parser** from the delegation-failure path; it already handles unclosed and
  leftover tags.
- **Choose a delivery path:** a send on the principal's channel through the gateway, or
  the bullpen plus a review task as #1990 does. Dedupe against a send the coordinator made
  itself.
- **Shrink the guidance.** The non-principal guidance becomes one line saying where notes
  for the principal go, replacing the "no opening…, no closing aside, no note for the
  principal" and two-sends prose.

Then:

- **Risk:** #1990 found that deepseek-v4.1-flash is sensitive to where the tag instruction
  sits. A/B the placement.
- **Verify:**
  - A new scenario case: a non-principal turn where the principal needs to hear something.
  - Unit tests on the relay.
  - Neither suite runs the Stage 2 judge, so probe it with a scratch script, as #1990 did.

### PR 6: move prose-only rules into code

- **`email-draft-save`** refuses the principal's account when the coordinator calls it,
  with "delegate to ceo-inbox"; ceo-inbox keeps the ability. Remove the sentence from the
  YAML and from the `email-etiquette` turn guidance.
- **`web-fetch` and `web-browser`** refuse Google Docs, Drive and Sheets URLs with "call
  skill-activate google-workspace".
- **`delegate` failure results carry the next step.**
  - From `@calendar`: "don't present it as a clear day", in `next_step`.
  - From `@contacts`: tell the principal, then retry.
- **Apply `agentPersona.emailSignature`** in `email-send` and `email-reply`, or render it
  into the identity block. Then delete the signing line.
- **Verify:** unit tests for each refusal, and scenarios 13a–d.

### PR 7: backlog line for proactive surfacing

On principal turns with anything pending, inject one line: the counts of decay warnings,
pending approvals and tasks waiting on the principal, plus "raise the oldest at a natural
pause". The YAML keeps one sentence about flagging sensitive items.

Open work: find a cheap source for the counts, and add a new scenario case (none covers
proactive surfacing today).

### PR 8: routing-oriented roster

Add a short routing field to agent YAMLs (for example `delegate_when`) and render the
roster from it, keeping `description` for docs. Then drop the coordinator's per-specialist
routing sentences (the inbox triggers and calendar).

The agent YAML schema is a public API surface, so this needs a changelog callout. It
overlaps #2025 (specialist prompts).

### PR 9: wake-only SKILL.md content

Some SKILL.md content applies only on task wakes:

- `tasks`: Resuming, Finishing, browser sessions across wakes, and past-due milestones.
- `documents`: Placement, Retention, and Manifest first.

Inject it at wake time (the runtime already detects wakes for the workspace manifest), or
move it to `references/`. `contacts` and `ceo-inbox` also pin both skills, so run their
smoke cases too.

### PR 10: negation pass on injected blocks

These blocks sit outside the budget but are read on every turn they appear:

- `non-principal-reply-shaped`: lists questions never to ask.
- The security block: two NEVERs.
- The date guardrail: quotes "Monday May 19".

Same principles as PR 3.

### Final phase: specialist prompts in curia and curia-deploy

The coordinator is where these lessons get proven, but the specialists grew the same way,
and several are larger than the coordinator. Approximate `system_prompt` sizes today, YAML
only:

| Repo | Agent | Chars | Tracked in |
|---|---|---:|---|
| curia | ceo-inbox | ~57.7k | #2025 |
| curia | calendar | ~27.7k | #2025 |
| curia | meeting-debrief | ~18.5k | #2025 |
| curia | contacts | ~15.3k | #2025 |
| curia | diagnostics | ~7.3k | — |
| curia | research-analyst | ~4.6k | — |
| curia | setup-wizard | ~4.3k | — |
| curia-deploy | social-media | ~46.6k | curia-deploy#276 |
| curia-deploy | writing-scout | ~27.7k | curia-deploy#276 |
| curia-deploy | t2125-expense-tracker | ~18.1k | curia-deploy#276 |
| curia-deploy | essay-editor | ~15.8k | curia-deploy#276 |
| curia-deploy | security-triage | ~10.4k | curia-deploy#276 |
| curia-deploy | digest | ~1.7k | — |

This plan does not list that work; scope it per agent when the phase starts. What carries
over:

- **The principles above, and the same search.** Look for restated code rules, rules stated
  more than once, quoted anti-examples, style text that overrides settings, trigger-only
  text, and references to tools the agent doesn't pin.
- **Behavior coverage before cuts.** Coordinator cuts are gated by `pnpm scenarios` and
  `pnpm smoke`. Specialists have smoke cases but no scenario suite, and custom-agent tests
  live in curia-deploy's `tests/eval`. Each agent needs enough behavior checks to run an
  A/B before its prompt shrinks.
- **A budget for each agent.** In curia, add a row to `AGENT_BUDGETS` in
  `prompt-budget.test.ts` once an agent is trimmed, and count its pinned SKILL.md bodies as
  the test does. curia-deploy needs an equivalent guard for custom agents.
- **The audience is different.** Specialists mostly read briefs from the coordinator, not
  messages from the principal. Their voice and audience rules differ, and some coordinator
  moves (such as the non-principal turn guidance) don't carry over as they are.
- **Order.** Start after the coordinator PRs, because several of them change surfaces the
  specialists also read: the `tasks` and `documents` SKILL.md, `tool.json` descriptions,
  and the roster field. Do ceo-inbox first: it is the largest, and it pins both skills.

## What will break along the way

- **Unit tests that pin prompt text:**
  - `tests/unit/agents/loader.test.ts` checks for `**Channel ownership.**` (PR 1). Its #1958
    block also requires four phrases to appear exactly once: `return exactly \`NO_REPLY\``
    (PR 4), `is **always** transfer-ownership` (PR 3 or 4), and `NEVER name tools,
    systems` plus "more than one agent was involved" (PR 2).
  - `coordinator-calendar-routing.test.ts` slices the prompt by heading.
  - `coordinator-cold-compose.test.ts` pins one sentence.
  - `prompts/trigger-guidance.test.ts` pins turn-guidance text, and caps all of it
    together at 6,000 chars (PR 4).
- **Exfiltration markers.** They are built from `system_prompt` lines
  (`src/dispatch/prompt-exfiltration-markers.ts`). Text moved to turn guidance stays
  covered; text moved to code-owned blocks or tool descriptions does not.
- **Tool-definition headroom** is about 2.3 KB. Rung-3 moves must fit or be offset.
- **Shared text.** The `tasks` and `documents` SKILL.md files and the `tool.json`
  descriptions are shared with other agents.
- **Every PR** needs an agent `version` bump (patch for prompt changes) and a CHANGELOG
  entry.

## Spotted, out of scope

- `src/agents/prompts/routing-decision-guardrail.ts` still lists calendar as
  handle-directly. Only `scripts/spikes/voice-brain-parity` imports it; the live voice
  runtime does not.

## Appendix: draft rewrites

These are starting points, not final text. The PR that uses one runs it through the A/B.

**A. People** (~610 chars, replaces ~2,530)

```
### People
My own contact ID, in "Your Contact Details", is the one ID I use without resolving.
Everyone else (the sender, third parties, recipients and CCs) I resolve by briefing the
contacts specialist: "Brief me on Sarah Johnson, I'm about to schedule a meeting with
her." I use the IDs and addresses from this turn's <resolved_entities> block and brief
again for anyone missing from it. Before sending to anyone but the principal, I resolve
everyone I name, and ask the principal for details only as a last resort. If a briefing
fails, I tell the principal and retry, and act once I have the ID.
```

**B. Who I am** (~790 chars, replaces ~2,090; PR 6 removes the last sentence once the signature is applied in code)

```
## Who I am
I am a person, a chief of staff, not a platform. I speak in the first person singular to
everyone ("I checked your calendar", "I'll follow up"), and work a specialist did is mine
when I report it. I describe what I can do the way a person would: "I have it on file",
"I'll look into that", "I'll check with my research team". Messages carry outcomes in
plain language ("I've split this into a few parts; I'll report back in about 15
minutes"); tools, agents, systems, IDs, file paths and task mechanics stay out of them,
the principal's included. Asked how I work, I say briefly that I'm an AI assistant with
access to their contacts, email and a research team. When something fails, anyone but the
principal simply hears that I'll follow up. I sign emails with my name and title.
```

**C. Tasks and routines** (~500 chars, replaces 1,545)

```
### Tasks and routines
Deferred or trackable work ("remind me to", "track this", "follow up next week") is
`task-create`, with `wake_at` for a one-shot wake. Recurring routines use the scheduler
tools: a new routine or an extra run is a new job, a change to an existing one is an edit,
and when it's unclear which the principal means, I ask. I manage these myself rather than
pointing the principal at the web UI. Before answering "what's open?" or "what are you
working on?", I check `task-list`.
```

**D. Non-principal turn guidance** (~470 chars, added to `non-principal-reply-shaped`; moves ~1,760 out of the YAML)

```
Your final response is delivered to this sender as written; the principal does not see
it first, so it holds only the message for them. If nothing should go back (an automated
notice, an FYI, a decline that needs no acknowledgment, a message not meant for you),
respond with exactly NO_REPLY and nothing else. When the principal needs to know
something from this exchange and it is actionable for them, tell them in a separate send
to an address in Principal Contact Details.
```

After PR 5, the last sentence becomes: "Put anything for the principal inside
<note_for_principal></note_for_principal>; it is removed from the reply and delivered to
them."
