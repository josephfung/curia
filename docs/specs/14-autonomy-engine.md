# 14 — Autonomy Engine

**Status:** Implemented (Phase 1, 2 & 3)

---

## Overview

A single global autonomy score (0–100) governs how independently Curia operates across all agents and skills. The score is CEO-controlled, Postgres-persisted, and injected into the Coordinator's system prompt on every task — so Curia self-governs in real time without a restart.

**Phase 1 (implemented):** Score storage, CEO read/write skills, behavioral prompt injection.
**Phase 2 (implemented):** Hard execution gates — skill invocations blocked when score is below the skill's declared `action_risk` floor.
**Phase 3 (implemented):** Automatic score adjustment driven by a structured action log and a Competence / Commitment / Compatibility scoring formula. See `src/autonomy/` and issue #148.

---

## Why a Single Global Score

Curia is a single deployed instance serving one principal. There is no meaningful distinction between "Curia's email autonomy" and "Curia's calendar autonomy" at this stage — trust is a property of the whole relationship, not individual capabilities.

A global score is:
- **Interpretable** — the CEO can reason about what "75" means without understanding the system internals
- **Adjustable in real time** — one command changes behavior across all channels and skills immediately
- **A clear foundation** — per-capability scoring can layer on top in Phase 2 once the global baseline is established

---

## Autonomy Bands

The score maps to one of five named bands. Each band has a behavioral description that is injected verbatim into the Coordinator's system prompt.

| Band | Score | Label |
|---|---|---|
| **Full** | 90–100 | `full` |
| **Spot-check** | 80–89 | `spot-check` |
| **Approval Required** | 70–79 | `approval-required` |
| **Draft Only** | 60–69 | `draft-only` |
| **Restricted** | < 60 | `restricted` |

### Band Behavioral Descriptions

These are injected as-is into the Coordinator's system prompt. They define self-governance behavior at each band. The text below is the `autonomy.gating: tier` set; under `band` a second set that matches the [band table](#band-gating-2159) is injected instead (`BAND_DESCRIPTIONS_BAND_GATING` in `src/autonomy/autonomy-service.ts`).

**Full (90–100)**
> Act independently. No confirmation needed for standard operations. Flag only genuinely novel, irreversible, or high-stakes actions — where the downside of acting without checking outweighs the cost of the pause.

**Spot-check (80–89)**
> Proceed on routine tasks. For consequential actions — sending external communications, creating commitments, or acting on behalf of the CEO — note what you're doing in your response so the CEO maintains visibility. No need to stop and ask.

**Approval Required (70–79)**
> A direct instruction from the principal is your approval: carry it out, taking the conservative default for any detail it leaves open (view-only access, the latest version) and saying which you chose. Ask first only when the context cannot tell you which of several things the principal means, such as two equally likely files or people. For consequential actions you take on your own initiative, present your plan and explicitly ask for confirmation before proceeding. Routine reporting, summarization, and information retrieval can proceed without approval.

**Draft Only (60–69)**
> Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on behalf of the CEO without an explicit instruction to do so. Surface your work for review; execution requires a direct go-ahead.

**Restricted (< 60)**
> Present options and analysis only. Take no independent action. All outputs are advisory. Every step that would have an external effect requires explicit CEO instruction.

---

## Data Model

### `autonomy_config` — live state (single row)

```sql
CREATE TABLE autonomy_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band        TEXT NOT NULL,        -- derived label, stored for query convenience
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,        -- 'ceo' or 'system' (Phase 3+)
  CONSTRAINT single_row CHECK (id = 1)
);
```

The `CONSTRAINT single_row` enforces exactly one row at the database level. All writes use `INSERT ... ON CONFLICT (id) DO UPDATE`. The `band` label is derived from `score` at write time and stored — no recomputation on every read.

**Default:** 75 (`approval-required`). Conservative starting point — Curia confirms consequential actions until the CEO adjusts from here as trust is established.

### `autonomy_history` — append-only audit trail

```sql
CREATE TABLE autonomy_history (
  id             BIGSERIAL PRIMARY KEY,
  score          INTEGER NOT NULL,
  previous_score INTEGER,           -- NULL on first write
  band           TEXT NOT NULL,
  changed_by     TEXT NOT NULL,     -- 'ceo' or 'system'
  reason         TEXT,              -- optional CEO note
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every write to `autonomy_config` appends a row here. Never updated or deleted. This table is the exact foundation Phase 3's auto-adjustment will write to when recording system-initiated changes.

---

## Skills

Both skills are pinned to the Coordinator only — not available to other agents.

### `get-autonomy`

- **Sensitivity:** `normal`
- **Action risk:** `none`
- **Inputs:** none
- **Behavior:** Queries `autonomy_config` for the current score and band, plus the last 3 rows from `autonomy_history`. Returns a human-readable summary.

Example output:
```
Autonomy score: 75 — Approval Required

At this level, I'll confirm before taking consequential actions like
sending email or creating commitments, but can proceed independently
on research and summarization.

Recent changes:
  2026-04-03  75 → 75  (approval-required)  "starting point"  — ceo
```

### `set-autonomy`

- **Sensitivity:** `elevated` (requires a live principal turn — #1126; the `action_risk` below is inert while `elevated`, since elevated skills are exempt from the autonomy gate)
- **Action risk:** `high`
- **Inputs:** `score` (integer 0–100), `reason` (string, optional)
- **Behavior:**
  1. Validates `score` is in `[0, 100]`
  2. Reads current score from `autonomy_config`
  3. Derives new `band` label from `score`
  4. Upserts `autonomy_config` with new score and band
  5. Appends to `autonomy_history` with `previous_score`, `changed_by: "ceo"`, and optional `reason`
  6. Returns confirmation with old score → new score and band name

Any invocation without a valid CEO `CallerContext` fails closed.

---

## Prompt Injection

The autonomy block is loaded from Postgres and appended to the Coordinator's system prompt **on every task**, following the same runtime enrichment pattern used for date/timezone injection.

**Why per-task, not once at startup:** The CEO may change the score mid-session. Per-task loading ensures a `set-autonomy` call takes effect immediately on the next action — no restart required. Cost is one single-row Postgres read per task.

### Injected block format

```
## Autonomy Level

Your current autonomy score is {score} ({band-label}).

{band-behavioral-description}
```

---

## Skill `action_risk` Declaration

Every skill manifest must declare an `action_risk` field indicating the minimum autonomy score at which this skill may run without explicit CEO confirmation.

```json
{
  "name": "send-email",
  "action_risk": "medium"
}
```

Named labels map to minimum score thresholds:

| Label | Min score | Capability class |
|---|---|---|
| `none` | 0 | Read-only, no side effects |
| `low` | 60 | Internal state writes (memory, contacts) |
| `medium` | 70 | Outbound communications (a send to the principal alone is exempt, see [Principal-only send bypass](#principal-only-send-bypass)) |
| `high` | 80 | Calendar writes, commitments on behalf of CEO |
| `critical` | 90 | Financial / destructive / irreversible actions |

A raw integer (0–100) may be used for precision (e.g. `75` for a skill that should unlock just above `approval-required` but below `spot-check`). Values outside `[0, 100]` produce a validation error at skill load time and prevent startup.

**This field is required in all skill manifests.** Validated at load time (startup rejects missing fields). Enforced at runtime: the execution layer blocks skill invocations when the live score is below the skill's floor.

### Quick reference by capability class

| Capability class | Recommended value | Rationale |
|---|---|---|
| Read / retrieve / summarize | `none` | No external effect — always safe |
| Internal state writes (memory, contacts) | `low` | Affects future behavior but reversible |
| Outbound communications | `medium` | Reaches people outside Curia. A send to the principal alone skips the score gates |
| Calendar writes / commitments | `high` | Creates real-world commitments |
| Financial / destructive / irreversible | `critical` | Never fully autonomous |

---

## Adding a New Agent — Autonomy Checklist

1. **Coordinator handles injection automatically** — standalone agents wired outside the Coordinator need explicit `autonomyService` injection (same pattern as date/timezone)
2. **Review pinned skills** against the `action_risk` floor table above
3. **Document cross-band capabilities** in agent YAML comments if the agent has skills across multiple bands

See [adding-an-agent.md](../dev/adding-an-agent.md) for the full agent setup guide.

---

## Phase 2: Hard Execution Gates (Implemented)

Phase 2 enforces three hard gates:

| Condition | Gate |
|---|---|
| `score < skill.action_risk_floor` | Skill invocation returns advisory failure — no throw, same `{ success: false }` shape |
| `score < 70` | `OutboundGateway.send()` blocks direct outbound dispatch, except a send to the principal alone; draft creation remains available as the intended fallback |
| `score >= 90` | Elevated skills callable without per-action CEO confirmation |

The `OutboundGateway` (see [15-outbound-safety.md](15-outbound-safety.md)) is already the natural choke point — adding an autonomy check there requires no architectural change.

### Principal bypass

When a task is **principal-originated** (initiated by a direct CEO message, as determined by `isPrincipalOriginated(taskMetadata)`), both Gate A and Gate B are skipped. The autonomy gate governs *autonomous* behavior; an explicit CEO instruction is its own authorization and must not be blocked by the score the CEO themselves set.

Implementation: the execution layer calls `isPrincipalOriginated()` before evaluating autonomy gates. If the task traces back to a principal message, the gates are logged but not enforced. Bypasses are written to the audit log at `info` level for operator visibility.

Scope: principal bypass applies to Gates A and B only. It uses task **lineage** (`isPrincipalOriginated` on effective standing) — a woken principal-lineage task can inherit it via the ladder at high trust. This is deliberately a *different* notion of "principal" from the elevated-skill gate (`sensitivity: 'elevated'`), which requires a **live principal turn** and is never bypassed or inherited (#1126). Acting *within* CEO-authorized work (a `normal` skill) can reasonably be inherited at high trust; *exercising authority* (an `elevated` skill) needs the human now. See [03-tools-and-execution.md](03-tools-and-execution.md) and ADR-017.

### Principal-only send bypass

A send whose recipients are **all the verified principal** also skips Gates A and B, whoever started the task (#2337). The principal bypass above asks *who started the task*; this one asks *who the message goes to*. Messaging the principal is the safest thing an autonomous task can do, and it is how a restricted Curia reports back or asks for help. Without it, a system- or agent-originated report below 70 became an approval request asking the principal to approve a message to themselves.

- **Which sends.** The send skills with a Gate C carve-out (`email-send`, `email-reply`, `signal-send`, `sms-send`, `slack-send`). The test is the #1301 recipient check (`resolvePrincipalIsSoleRecipientFromSkillInput`) on the recipients Gate C would judge: references replaced by the addresses resolved before the gates, and for `email-reply` the thread's To and CC with Curia's own mailboxes left out. Two of the principal's own addresses still count. Any third party, any `bcc`, an unmodeled recipient field, a reference that can't be resolved, or a thread that can't be fetched keeps the gates on.
- **Only when it matters.** The check runs only when Gate A or B would block, so a send above the threshold costs nothing extra.
- **Gate C still runs, and can still hold the send.** For an outside originator under `tier` gating, the #1301 carve-out allows a principal-only send only from a `known` contact or above. An `unknown` or `blocked` originator still escalates. An outside originator with no tier recorded still fails closed (#1059), under both `tier` and `band`. Under `band`, Gate C passes every other send on to the gateway. System and agent tasks skip Gate C.
- **Why it is safe.** The gateway already lets a send to the principal alone past its own score gate, and does not send it to the band review. The relay budget caps how often an outside contact can make Curia message the principal. Emails with attachments are not counted (see [Relay budget](#relay-budget-relaybudget-srcautonomyrelay-budgetts-1320)). A report whose only recipient is the principal is never a disclosure (see *Personal details* below).
- **Logged** at `info` (`gates A and B skipped — recipient set is exclusively the verified principal`), like the lineage bypass.

`deliver-approval` stays `action_risk: none`. It takes no recipient input (it always messages the principal, on a channel chosen from the principal's preferences), so the recipient check has nothing to read. It is a system path that has to work at any score.

### Approval delivery and expiry

A gated action that files an approval (ADR-018) stays `pending_approval` until its `expires_at`. Filing an approval notifies no one (#2159). The raise site:

- creates the row;
- registers what the principal should be shown, with contact references resolved to names (#2033);
- queues one `principal.report` item, the approval's single digest mention.

The blocked agent is told to deliver the approval itself with `deliver-approval`. That tool sends it on **one** channel the agent picks from the principal's standing preferences. Fresh installs seed a preference of Signal, then SMS, then email.

- Delivery claims `notification_sent_at` atomically, so an approval is pinged once.
- A failed send releases the claim, and the tool's error lists the channels still available.
- Signal and Slack deliveries are bound, so a 👍/👎 reaction resolves the approval.
- When a dispatcher-relayed reply is held after the turn has ended (by Gate C in the dispatcher, or by the score gate on the relay's email send), the coordinator is woken to deliver it.
- A specialist cannot call `deliver-approval`, so its advisory tells it to hand the reference to the coordinator.

A system interval (`autonomy.approval_expiry.sweep_interval_minutes`, default 15) runs with no agent turn and no LLM call, and does two things:

1. **Safety net.** It delivers, by email or the next available channel, any approval no one delivered within 15 minutes, and logs a warning. With the 15-minute interval, that lands 15–30 minutes after the approval was raised.
2. **Expiry.** It marks stale rows expired and queues a digest item for each (#2013, #2159).

See [Configuration](../dev/configuration.md#autonomyapproval_expiry).

### Who resolved an approval

`resolved_by` records who actually decided (#2159):

- `principal`: a 👍/👎 reaction on the approval message.
- `coordinator`: an agent called `approve-action`, `deny-action`, `dismiss-action` or `send-draft` on its own reading of the conversation.
- `system`: expiry or gate rejection.

The scoring pass treats only `principal` resolutions as the principal's feedback. Coordinator-resolved rows are scored with null flags, so they carry no signal. Rows written before #2159 say `ceo`.

### The principal's digest queue

Things the principal should hear about, but not right now, are `principal.report` bus events. That covers:

- "act, then tell" items filed with `report-to-principal`;
- notes cut out of replies to someone else;
- content-filter block notices;
- approval mentions and expiries.

The audit log records them, and `ReportQueue` (`src/reports/report-queue.ts`) reads them back by `audit_log.seq`. Digest jobs call `list-principal-reports`, include the numbered items, and call `ack-principal-reports` with the returned cursor once the digest is sent. A daily check (`autonomy.report_fallback`) sends a plain weekly summary itself when the oldest unreported item is more than seven days old, which covers installs with no digest job.

### Effective standing — the bypass ladder (woken/derived tasks)

The principal-bypass consumes **effective standing**, not raw lineage. (The elevated-skill gate does not: it requires a live principal turn, which no wake, scheduled fire, or derivation ever is — #1126.) For any **non-heartbeat execution** (a fresh principal inbound, a synchronously-delegated sub-task, or a scheduler-create fire) effective standing *is* the task's lineage — behaviour above is unchanged. Of those, only fresh principal inbounds and synchronous delegation are *live principal turns*; a scheduler fire is a scheduled autonomous execution, never live (so it can drive the lineage-based bypass but never the elevated gate). For a **heartbeat-woken** task the score-keyed **bypass ladder** governs how much of the chain's lineage standing the woken execution inherits. The lineage (`tasks.originator`, see [19-tasks-and-backlog.md](19-tasks-and-backlog.md)) is pure audit and the *ceiling*; the live score can only ever **downgrade** it to `agent` (propose-only), never grant standing the lineage didn't have.

| Live score | Same-task heartbeat wake | Agent-spawned (derived) child task |
|---|---|---|
| `< same_task` (70) | downgrade → agent | downgrade → agent |
| `same_task`–`derived_child` (70–89) | keep lineage standing | downgrade → agent |
| `>= derived_child` (90) | keep lineage standing | keep lineage standing |

A wake carries a `wakeContext` marker (stamped by the scheduler when it fires a `BacklogHeartbeat`-minted job); a task is **derived** when `source = 'agent'` or it has a parent. Effective standing is computed from the **live** score at invocation, so lowering the score removes inherited bypass on the very next action. Thresholds are configurable under `autonomy.bypass_ladder` (`same_task` default 70, `derived_child` default 90); `same_task` must not drop below 60 (schema-enforced). After #1126, `system` standing confers no gate power at all (it is pure audit lineage plus the "skip the external-contact tier gate" signal); the ladder therefore governs exactly one thing — whether a woken/derived **`normal`**-skill execution inherits the principal-bypass. See ADR-017 and ADR-011 for the design rationale (#1125 foundation, #1126 completion; investigation #1060).

Effective standing is also what handlers see: `ctx.taskMetadata` carries the post-ladder standing (audit logs read the raw lineage separately). #1126 abolished the handler-level origination re-checks on every `elevated` skill (the gate is now the single enforcement point), but two `action_risk: 'none'` `normal` skills the autonomy gate cannot govern deliberately retain a handler re-check — `send-draft` and `calendar-list-events` (an egress/parameter check) — and they must see post-ladder standing. Effective standing also keeps the lineage-forwarding skills (`delegate`, `scheduler-create`, `bullpen-post`, `bullpen-reply`) from riding or propagating standing the woken task no longer holds — a freshly-derived sub-turn carries no `wakeContext` and would otherwise escape the ladder. **Fail direction:** when the live score is momentarily unreadable, a *live* turn fails open (a transient DB issue must not disable a human-directed agent), but a *woken* task fails closed on non-read actions — with no human in the loop and no score, there is no basis to inherit autonomous standing.

---

## Band gating (#2159)

`autonomy.gating: band | tier` (`config/default.yaml`) chooses who decides when Curia asks first. It defaults to `band` (#2192). `tier` is the contact-tier policy described above (Gate C's tier veto and the outbound filter's Stage 2.5), kept selectable for one release before it is removed (#2194). Under `band` the score decides, and contact tier only matters when an outsider is steering Curia. See [ADR-049](../adr/049-band-driven-autonomy.md).

### Behavior by band

| Band | Score | Taking on new work | Coordinating | Speaking or committing as the principal | Principal hears about it |
|---|---|---|---|---|---|
| Full | 90+ | Proceeds | Acts | Acts, after the fact check; **asks first** on money or legal | Digest, notable items only |
| Spot-check | 80–89 | Proceeds, reports | Acts | Routine: acts, after the fact check; a commitment, money or legal: **asks first** | Digest |
| Approval | 70–79 | Proceeds, reports | Acts | **Asks first** | Digest, plus the asks |
| Draft | 60–69 | Principal confirms | Drafts | Drafts | Digest, plus the asks |
| Restricted | <60 | Proposes only | Drafts only | Drafts only | Digest |

**Stakes (#2473).** When Curia speaks as the principal on its own initiative, the send review also rates what the message commits them to, and the rating sets the score it needs to go out without asking:

| Stakes | Examples | Sends without asking at |
|---|---|---|
| `routine` | Acknowledgements, thanks, scheduling logistics, "got it" | 80+ |
| `commitment` | Agreeing to dates, deliverables, terms or introductions; anything the principal would have to walk back | 90+ |
| `financial_or_legal` | Payments, purchase orders, pricing, contracts, signatures, legal positions | Never: always held for approval |

Principal-directed sends (a live principal turn, or a replay of what the principal approved) are not stakes-gated: the principal decided.

At every band an outsider steering Curia means the action is held, the integrity rules block, and the fact check runs whenever Curia speaks as the principal. For sends to other people, Gates A and B are unchanged and apply on top. A send to the principal alone skips them at every band (see [Principal-only send bypass](#principal-only-send-bypass)), though Gate C can still hold it.

### Gate C under band (`runBandGateC`, `src/skills/execution.ts`)

| Case | 80+ | Below 80 |
|---|---|---|
| KG write from an unknown or blocked sender | escalate (#1290) | same |
| External originator with no tier | escalate (#1059) | same |
| A send (`HUMAN_SEND_SKILLS`) | proceed — the gateway's band review asks all five questions | same |
| Any other action at medium risk or above | ask *purpose* if an outsider (below `trusted`) initiated it; escalate on "steered" | ask *purpose* and *speaks as principal*; escalate on "steered" or "yes" |
| A low-risk action | ask *purpose* if an outsider initiated it | same |
| Judge failure, or the drafting turn's evidence cannot be read (for a delegated specialist, including a delegation chain that cannot be followed to its root) | escalate | escalate |

Gate C leaves sends to the gateway because it sees only a truncated description with contact references, while the gateway sees the whole message and its resolved recipients; a hold there raises the same approval. At 80+, a non-send the tier policy would have escalated emits a `gate_proceeded` digest item. Unlike the tier gate, band Gate C also covers system- and agent-originated tasks.

### Send-time review (`BandSendReview`, `src/dispatch/band-send-review.ts`)

Under `band` the outbound filter's `contact-data-leak` rule and Stage 2.5 are off. After the integrity rules and Stage 2 pass, the gateway asks the escalation judge's brief (`src/autonomy/judge-brief.ts`). The judge sees the message, the recipients, the band and the drafting turn's evidence: the turn's tool results read back from the audit log (task → `tool.invoke` → `tool.result`), its task content and progress, and the "Who you serve" block. The evidence is passed beside the message, never written into it, and credentials are redacted before it leaves.

**Delegated turns (#2499).** A delegated specialist's task content is the coordinator's rewritten brief, which reads like principal-serving work whatever the sender asked. When the drafting turn carries `delegationOrigin`, the collector (`src/autonomy/send-evidence.ts`) follows `delegationOrigin.taskEventId` back through the audit log to the root task, the first one that was not itself delegated, at most four hops. For an inbound root it reads the `inbound.message` the dispatcher parented the task on, the sender's text before any preamble, plus up to five follow-ups a turn lane drained into that turn (`agent.task.input_injected`). Any other root (a scheduled job, a wake) gives its task content, labelled as a task rather than someone's words. Either way the collector adds up to five earlier inbound messages from the same sender on that conversation (matched on the channel sender id the root carries), newest first and each with the time it arrived, so a push made in an earlier email still reaches the judge when the message that started the work is bland. The origin travels as `originContent` (with `originAt`) and the history as `senderHistory`, beside the brief, and the judge is told to judge purpose by what the sender asked, earlier messages included. Everything is redacted like the rest of the evidence and trimmed from the middle: the origin to 4,000 characters, each earlier message to 600 and the history to 3,000 in all. In the 12,000-character budget the origin comes first, then the history, then the tool results. A chain or origin it cannot follow or read (a missing or malformed origin, an unreadable or non-task row, a loop, too many hops, a root or follow-up with no content) makes the evidence unavailable and marks the origin unresolved. Gate C then escalates, and the send review holds at every band without spending the fail-open allowance. A failed audit read is still an ordinary judge failure.

| Send | Questions |
|---|---|
| Principal-directed (a live principal turn) | grounding |
| Autonomous, from the principal's mailbox (#2474) | purpose, stakes, grounding, necessity, **off-thread**; speaks-as-principal is forced true in code |
| Everything else, at every band | purpose, speaks as principal, stakes, grounding, necessity |
| Any send with detected personal details | plus **disclosure**, principal-directed sends included |

`send-draft` is the exception: `send-draft` marks every call `humanApproved`, so the review keys on whether the principal directed this draft send (a live turn or an approval). An autonomous one (a woken task) gets all five questions; a principal-directed one is reviewed only for its personal details, and a draft the principal approved as written is not reviewed (see **Saved drafts** below).

| Answer | Effect |
|---|---|
| steered | hold, at every band (a personal-details bounce beside it goes first, #2333) |
| speaks as principal, `routine`, below 80 | hold |
| speaks as principal, `commitment`, below 90 | hold |
| speaks as principal, `financial_or_legal` | hold, at every band |
| unsupported claims or unneeded disclosures | bounce to the drafter once; Curia never cuts text out of a message. If the rewrite still has findings: at 80+ refused back to the drafter (not sent, told to rewrite again or tell the principal, a digest item queued), except that a relayed reply or a saved draft, which has no drafter waiting, is held instead; below 80 hold |
| judge failure | The stakes are unrated, so treated as `financial_or_legal`: hold at every band, without using the fail-open cap (#2473). A send with personal details in its own text bounces first at 80+, as below; its recheck holds. Only a principal-directed send, which is not stakes-gated, fails open: 80+: send with a `sent_without_review` item, at most five an hour, then hold until a judge call succeeds and email the principal once; below 80: hold. A failure on the recheck of a bounced draft holds. |

A sustained judge outage (provider down, or `escalation.judge.enabled: false`) therefore holds every autonomous send under band gating, each with its own approval and no single "the reviewer is down" notice; the once-per-trip notice covers only the principal-directed fail-open path. A stakes hold's approval names the rating and the judge's one-sentence reason (`Stakes: commitment. Why: …`), so the principal can tell why it asked. A missing or unknown rating is a malformed verdict, a judge failure. A stakes hold uses the `speaks-as-principal` rule, so an ask survives it (the approval shows both reasons). At 80+ a stakes hold never cuts the drafter's rewrite short: a draft that would also bounce for unsupported claims or unneeded disclosures bounces first (or blocks on the recheck), carrying the stakes hold beside it, and the clean rewrite is held for its stakes. Below 80 a hold for speaking as the principal still comes first.

A bounce publishes `outbound.blocked`, so a relayed reply goes through the dispatcher's rewrite, and shows the drafter only text quoted verbatim from its message. A hold raises an approval through the send's `holdRecipe` (each send skill replays itself; relayed replies replay through `dispatcher-relay`) and never publishes `outbound.blocked`; a hold with no approval behind it queues a digest item. Sends the principal approved (`humanApproved`), system notifications and sends to the principal alone are not reviewed; sends to the principal alone are capped by the relay budget instead (below). A block never publishes `outbound.blocked` either (it would restart the relay rewrite loop); the bounce ledger entry survives a block with its time refreshed, so each further draft is still a recheck until one is clean.

### Personal details under band gating (#2312)

See [ADR-054](../adr/054-authority-aware-pii-disclosure.md). Under `band` the gateway never redacts, cuts or tokenizes. The drafter is told to write the details it was asked for (the autonomy block's **Personal details** rule, `PERSONAL_DETAILS_RULE`; the LOW-TRUST sender block and the trust-score table defer to it), and a linked reply's block says to answer what the outreach needs. The flow is **detect → judge per item → policy table → act**, and no `[REDACTED: …]` token is ever delivered. `PiiRedactor.detect` finds the items in the subject, the body and the quoted thread (the principal-only bypass uses the full recipient set, Curia's own mailboxes excluded); the brief's `disclosure` question rules on each (at most ten; past that it rules on the message's own items alone and the quote is dropped, and more than ten of the message's own items are treated as unsupported) as `directed`, `inferred` or `unsupported`, and whether the recipient asked. Detected items are ruled on under `disclosure` only; `necessity` findings that overlap them are dropped, and a report whose only recipient is the principal is never a disclosure.

**Authority evidence** is computed by code, never taken from the judge (`SendEvidenceCollector`): the originator's tier, system role and channel; whether the originating message authenticated its sender (`TaskOriginator.authenticated`, stamped with the originator and carried to wakes and child tasks, absent means false); the live turn; the bound task and its root task; the reply's task link and its strength; the principal's recorded yes/no for the thread; and the `principal.report` items the turn filed. Text inside forwarded or quoted content is labelled so and grants nothing.

| Ruling | Who directed (code-confirmed) | At 80+ | Below 80 |
|---|---|---|---|
| `directed` | the principal: live turn, the send's task or its root task, or a recorded yes | send | send |
| `directed` | a trusted contact on an authenticated channel (stamped and current tier both `trusted`; checked before a principal-rooted task) | hold for the principal (not an ask) | hold for the principal (not an ask) |
| `inferred` | a principal-directed task, or a strong link to one | send | hold (an ask if askable) |
| `inferred` | only a weak link | hold if askable, else bounce | hold if askable, else bounce |
| `unsupported`, requested, requester askable | n/a | hold, ask | hold, ask |
| `unsupported` or any other `directed`/`inferred` | n/a | bounce | bounce |

A bounce goes to the drafter once. A second unapproved item is a block at 80+ and a hold below 80; a relayed reply or a saved draft, with no drafter, is held, except a saved draft answering a cold stranger's request, which is refused (no approval; the digest is told). A principal-rooted task reached by an outsider's turn downgrades `directed` to `inferred`. An ask survives a hold for speaking as the principal (a stakes hold, #2473; the approval shows both reasons); any other hold beside it drops the ask. A bounce over personal details beats a hold for steering (alone, or beside speaking for the principal below 80), whose approval would show them to be sent as written: the drafter rewrites without them first, and a recheck that is still steered holds (#2333). A saved draft, which can't be rewritten, holds with every reason; one refused for a cold stranger's request raises no approval, and its refusal and digest note still say it was steered. A steered send that speaks for the principal below what its stakes need is held for both reasons. A block outranks any hold but keeps its reasons, so the hold a relayed reply or saved draft gets instead shows them. An ask is raised only when the requester was asked for the data and is **askable**: every non-principal recipient is a linked counterparty of a principal-directed task or a `known`/`trusted` contact. A cold stranger gets a bounce, a polite decline and a digest note. If the judge fails or times out, an item in the message's own text is unsupported and not askable (fail closed): at 80+ the draft bounces, below 80 it holds, and a recheck holds. A send whose only items are in the quoted thread is an ordinary judge failure: it holds (stakes unrated, #2473), except that a principal-directed one fails open at 80+ without the quote (capped as above). When review is not running (a system notification), the tier redaction fallback applies.

**Quoted-thread exemption.** A detail only in the quoted thread is not a disclosure when every non-principal recipient was on the quoted message; otherwise the unauthorized quote is dropped, not bounced.

**Reply links** (`task_outreach`, [spec 15](15-outbound-safety.md#personal-details-outreach-links-and-asks)). A link is *strong* only for a direct match (address, known contact, or the organization's own domain) from an authenticated sender to a `confirmed` row (an explicit outreach act on a principal-originated turn); anything else, including a model-inferred match, is *weak*. A weak link never unlocks an `inferred` disclosure; it only makes the requester askable. A link never raises the sender's tier.

**Asks and decisions.** A `hold → ask` keeps the original send as the held action, and its approval leads with the question. `approve-action`, `deny-action` and reactions record the answer in `disclosure_decisions` (`decided_by`: `principal_reaction` or `principal_via_coordinator`): a yes authorizes that label to that counterparty on that thread, a no turns later asks there into bounces, and a live principal directive overrides an earlier no. `send-draft` records a yes only on a live principal turn with a delivered approval. Approved replays send intact; the approval display lists every personal detail (label and value), and `approve-action` refuses an approval carrying personal details that was never delivered.

**Matching an answer to its approval** (#2333). Only a reaction is matched in code; a text answer is the coordinator's to match. On a live principal turn the dispatcher lists the approvals the principal has been shown and not answered (pending, unexpired, delivered; newest first, at most five), each with its number (or short reference), description and an ask's question, and the runtime renders each as one JSON object labelled as data, never instructions, with the turn guidance (`src/agents/prompts/awaiting-answers.ts`). It says how to read the message: a yes approves, a no denies, a change to what is sent denies and makes the send the principal described (their live words direct it), and no answer, or a question back, leaves it pending; when it is unclear which approval, or whether any, is answered, the coordinator asks, and never approves on a guess. An approval emailed to the principal binds its thread (`approval_message_bindings`, channel `email-thread`), so a reply on that thread lists that approval first, marked as the one replied to; a queued approval email is bound when it is delivered, from its `outbound.delivered` fingerprint.

**Saved drafts.** `send-draft` runs the same detection and review (it cannot bounce, so anything but "send" holds); a principal-directed draft gets a disclosure-only review. A draft passes as approved only when its stored subject and body match what was approved.

Relayed replies skip the dispatcher's tier Gate C (except #1059's missing-tier escalate) and get all five questions at the gateway.

### Sends from the principal's mailbox (#2474)

See [ADR-062](../adr/062-curia-sends-from-the-principals-mailbox.md); the gateway's side is in [spec 15](15-outbound-safety.md#sends-from-the-principals-mailbox-2474). `ceo-inbox-send-draft` (`action_risk: 80`) sends a draft from the principal's own mailbox. How far Curia may go is a per-mailbox setting, config-store key `ceo_inbox/sending`, value string-encoded JSON `{ "<mailbox>": "<level>" }`:

| Level | Curia may send |
|---|---|
| `off` | nothing |
| `on_request` (default) | only principal-directed sends |
| `routine` | plus autonomous replies rated `routine`, at 80+ |
| `all` | plus autonomous replies rated `routine` or `commitment`, at 80+ and 90+; `financial_or_legal` never goes out autonomously |

The autonomous row of the band table, by setting and the review's stakes rating (the score gates are the stakes table above; an autonomous send also needs the gateway's limits in [spec 15](15-outbound-safety.md#sends-from-the-principals-mailbox-2474) to pass first):

| Setting | `routine` | `commitment` | `financial_or_legal` |
|---|---|---|---|
| `off`, `on_request` | no autonomous send | no autonomous send | no autonomous send |
| `routine` | sends at 80+ | held (above the ceiling) | held |
| `all` | sends at 80+ | sends at 90+ | held |

A hold, a refused limit, a failed review or a review bounce leaves the reply a draft and files one "Left as a draft in your mailbox" digest item with the reason, written for the principal. A reply that shares information not on the thread is held at every band, under every setting and rating (the `off-thread` question, which excludes acknowledgements, thanks, and the principal's own availability or logistics the reply settles, even when those are new; the reason reads "Held for the principal: it shares information that isn't on the thread, and Curia doesn't pass on new information without the principal.", followed by any other finding's stakes rating or plain-words reason).

Missing, unreadable or unknown values read as `on_request`, which never widens autonomy and keeps principal-directed sends working. The gateway reads the setting itself (`createSendLevelReader`, `src/skills/principal-send/send-level.ts`), for the mailbox that holds the draft (#2475; see [spec 15](15-outbound-safety.md) for the legacy `default` key). The setting is pinned into ceo-inbox's context. Autonomous sends under `routine` and `all` shipped in the second half of #2474. Under `off` and `on_request` an autonomous attempt is refused (`setting_off`, `not_requested`) and files no digest item.

- **Principal-directed** means a live principal turn, not an approval replay, and for an email-originated turn a verified sender. These sends are not stakes-gated (the principal decided), are not put in the spot-check sample pool, and are reviewed as spec 15 describes: a principal-written draft only for personal data that remains, a Curia-edited one for purpose, a Curia-written one for purpose and grounding.
- **Gates.** `ceo-inbox-send-draft` is in `HUMAN_SEND_SKILLS`, so band Gate C leaves its review to the gateway. Gates A and B never file an approval for it (`NO_QUEUED_APPROVAL_TOOLS`, `src/skills/execution.ts`): a blocked call is refused with "No approval request was created", and the draft stays where it is. A principal-originated call skips A and B as any other does. A Gate A or B refusal of an autonomous call (not one an outsider started: Gates A and B file nothing for it, so an outsider repeating the call adds no digest noise; the gateway does file one for `outsider_originated` under `routine` or `all`) files a "Left as a draft in your mailbox" digest item whatever the sending level, `off` and `on_request` included: the execution layer can't read the level (the exception to the "no digest item" rule above).
- **No approvals.** A hold or ask leaves the draft in the principal's Drafts folder with a reason, never an approval row. `sendPrincipalDraft` refuses a `humanApproved` replay outright, so nothing can reach the send through the approval queue.

### Relay budget (`RelayBudget`, `src/autonomy/relay-budget.ts`) (#1320)

Sends to the principal alone skip the review above, and Gate C allows them, so an outside contact who keeps writing could get Curia to message the principal without limit. The gateway counts those relays per originator and, past the budget, sends them to the digest. It applies under both `tier` and `band`.

A send counts when the principal is its only recipient and the task's originator is an outside contact at `known`, `unknown` or `blocked`, or with no tier recorded. The send skills that can reach the principal (`email-send`, `email-reply`, `signal-send`, `slack-send`, `sms-send`) pass the originator as `originator`; one without a usable contact id is not passed, so unrelated sends never share a count. Never counted: system notifications (approval prompts included), sends the principal approved or directed, work the principal, the system or an agent started, `trusted` contacts, sends with no originator, and emails with attachments (a digest item holds text only). A skill send to the principal alone that arrives with no originator logs a warning, so a send skill that stops passing one is visible.

The budget is `autonomy.relay_budget.per_hour` (default 3; 0 turns it off) over a sliding hour, in memory. A relay that is let through but then fails to send gives its slot back. Over the budget:

1. The relay becomes a `relay_deferred` digest item carrying the contact's name and the full redacted text. If that item cannot be recorded, the relay is sent after all.
2. The principal also gets one line on the same channel: "[name] has more updates. I'm holding them for your digest, or ask me for them anytime." At most one goes out per contact per hour; a notice that fails to send is tried again on the next deferral. The coordinator can list held items when the principal asks (`list-principal-reports`), which matters on installs whose only digest is the weekly fallback.
3. A warning log line and an `autonomy.relay_deferred` audit event record the originator's contact id, tier and channel, never the content. An unresolved sender's id is its raw address (`stampOriginator`): the notice and digest item name the sender by it, and the log line redacts it.
4. The skill gets `success` with `deferred_to_digest` and a note not to re-send the message another way, and registers no outbound context, so no reply binds to a message the principal never saw.

The budget runs after the content filter, so blocked content is never queued.

The digest tools (`list-principal-reports`, `ack-principal-reports`, `list-spot-checks`) refuse a task an outside contact started: held items carry other contacts' messages, and an acknowledgement would clear the principal's queue. The principal's own turns and Curia's scheduled digest jobs are unaffected.

### Sampling and feedback (`src/autonomy/sample-pool.ts`, `src/reports/`)

Sampling runs at every band and is independent of the gating policy. Autonomous actions that went out without the principal seeing them are logged in a pool; a few at a time are shown in the digest; the principal's verdict on them is the strongest evidence the Phase 3 scorer gets. The LLM judge never grades a pooled action.

**The pool.** A pool row is an ordinary `autonomy_action_log` row with `outcome = 'success'`, `scored_by = 'sample-pool'` and all three flags null. `findUnscoredTerminal` skips it (it is already "scored") and `countScored` / `findAllScored` skip it (no flags) until a verdict arrives. The row keeps the tool input when its JSON is 2,000 characters or fewer, plus the signals below, under `payload.sample`. A triage row also keeps the email's subject and sender when the tool's result carried them (`ceo-inbox-archive` and `ceo-inbox-label` return both).

| Written by | Rows |
|---|---|
| Outbound gateway (`HUMAN_SEND_SKILLS` and `dispatcher-relay`) | Every send to anyone but the principal alone, with the band review's signals |
| Execution layer (`isSampledTool`) | Triage tools (`ceo-inbox-archive`, `ceo-inbox-label`, `email-archive`, `email-label`) at any risk, and every tool at medium risk or above except `file-parse`, `web-browser` and `voice-learn` |

Left out: live principal turns, approved re-runs and system notices. The execution layer does not log sends a second time, since the gateway already did. `ceo-inbox-update-folders` is not sampled, because triage pairs it with an archive per message and sampling both would count one decision twice.

**Weights.** A candidate weighs 3 when it speaks as the principal, goes to a first contact (no contact record yet, or one under 24 hours old), was bounced or sent unreviewed by the band review, got through Gate C where the tier would have asked (`gateProceeded`), or is triage. Everything else weighs 1. Weights are relative and never zero, so routine actions stay drawable.

**The digest block.** `SpotCheckSampler` draws up to 3 samples per digest, by weighted random selection without replacement, from unsampled pool rows 7 days old or newer. The block is numbers and summaries only, with this header verbatim; row ids are never shown:

```
Spot check (optional, reply with a number):
1. <summary>
```

Email subjects and senders are written by outsiders, so they are cleaned before they reach a summary or a stored row: text is sanitized to a fixed point (entities decoded until stable), links and tags are neutralized, secrets are redacted, and every summary is one line. An email-enriched triage line is capped at 120 characters (`ENRICHED_SUMMARY_MAX`). A triage line with no readable subject ends "(details unavailable)", added after that cap.

Two paths draw: the scheduled daily/weekly debrief recap (`src/agents/prompts/debrief-recap-instruction.ts`, step 3 calls `list-spot-checks`) and the weekly fallback digest (`src/reports/report-fallback-digest.ts`).

**The number-to-action map.** Each draw stores `{ id, createdAt, conversationId, items: [{ n, actionLogId, summary }], deliveries }` in the config store under `reports` / `spot_checks`. Every write prunes sets older than 14 days and keeps at most 30. Writes are read-modify-write on one value, so they run one at a time through a process-wide queue (held on `globalThis`, because the bundled app and skill handlers load separate copies of the module).

`SpotCheckBinder` listens for `outbound.delivered`. When the delivered content carries the header, it binds that delivery (channel, message id, and for email the thread id) to the set drawn in the same conversation. Only then are the set's rows marked sampled (`payload.sample.sampledAt`) and kept out of later draws. A digest that never went out, or lost the block, binds nothing; its rows return to the pool and the unbound set ages out.

**Replies.** A live principal message that starts with a number then `good` or `bad` ("2 bad, that was a renewal notice") gets the `spot-check-reply` turn guidance (`looksLikeSpotCheckReply`, `src/dispatch/turn-guidance-triggers.ts`), unless Curia was only CC'd: that mail is written to someone else. The match is anchored to the start of the message and limited to 400 characters; for email the Subject line and quoted text are cut first (`spotCheckCandidateText`, which recognises `>` quotes, "On ... wrote:", "Original Message" rules, Gmail's "Forwarded message" line, Apple Mail's "Begin forwarded message:", a classic Outlook line of ten or more underscores, and an Outlook `From:` header after a blank line or the `---` rule Outlook on the web's `<hr>` becomes). The guidance is conditional (ignore it when the number refers to something else) and asks the coordinator to tell the principal what was recorded and what was skipped. It replaces `principal-reply-shaped` (which says to ask what is being replied to) and points the coordinator at `record-spot-check`. When an outbound-context block was injected, its own keys stay and `spot-check-reply` is added beside them.

On the same turns the dispatcher parses every number-and-verdict pair from that cut text (`parseSpotCheckVerdicts`) and stamps them into the trusted task metadata as `spotCheckVerdicts`. `mergeTaskMetadata` strips the key from channel and injection metadata, as it does `originator`, so only the dispatcher sets it.

`record-spot-check` (in the `reports` bundle, `action_risk: none` so the principal can answer at any band) takes `verdicts: [{ n, verdict: good | bad, reason? }]`:

- **Which digest:** an email reply resolves only against the set delivered on its own thread, with no time limit; on a thread no digest went out on, it fails. The 24 hour fallback is for chat replies (Signal, Slack and the like): they resolve against the most recent delivered set within 24 hours, unless a newer set was drawn after its latest delivery (bound or not), when the reply is ambiguous and fails. No match, or a number the set does not have, returns an error telling the coordinator to ask the principal. It never guesses.
- **Checked before writing:** every number is checked before the first write. One number given two different verdicts fails the call. Silence records nothing.
- **Who:** live principal turns only. A non-principal "2 good", and any woken task, is refused before anything is read.
- **Only what was typed:** every requested pair must be in the turn's `spotCheckVerdicts` stamp, or nothing is recorded. A tool result, or text below a recognised quote or forward marker, cannot add a pair. Text the principal types or pastes above the marker can, and so can a forward whose marker is not recognised; the read-back of what was recorded is the check on those. Reasons are not checked.
- **Each write reported:** the writes are separate updates. A number whose row is no longer gradable comes back in `skipped`; if all are skipped the call fails. If a write throws, the call fails with an error naming the numbers recorded and the numbers that failed; resending the failed ones is safe.

**Scoring.** `recordPrincipalVerdict` sets `competence_flag` (good = 1, bad = 0), `scored_by = 'principal'` and `payload.sample.verdict = { good, reason }`. `commitment_flag` and `compatibility` stay null. The scorer weighs a principal-scored row 3× in the time-decayed average. A second verdict on the same row replaces the first.

See [ADR-049](../adr/049-band-driven-autonomy.md).

## Phase 3: Automatic Score Adjustment

Phase 3 implements automatic score adjustment based on `autonomy_action_log`, using a composite formula:

```
Capability Score =
  0.45 × Competence +
  0.35 × Commitment +
  0.20 × Compatibility
```

Key constraints:
- Minimum 30 scored actions before any automatic adjustment fires
- Time-decay weighting (recent actions weighted more heavily via exponential half-life)
- Score cannot increase if competence error rate exceeds the configured threshold (default 20%). The rate covers the last 30 competence-flagged rows no older than `errorRateWindowDays` (default 90), shadow rows excluded
- CEO cooldown: no auto-adjustment for 7 days after a manual CEO `set-autonomy`
- Unparseable LLM-judge replies retry until `unparseableAfterDays` (default 3), then persist null flags with `scored_by: 'llm-judge-unparseable'` so they leave the queue without biasing the capability score
- `expired` approvals carry no signal: new rows are scored with every flag null, and `computeCapabilityScore` skips old `expired` rows that still carry flags. The former `weakExpiredWeight` setting is retired: a config that still sets it boots, and the value is ignored.
- A principal's spot-check verdict weighs 3× a judged row of the same age (see Sampling and feedback)
- All automatic adjustments write to `autonomy_history` with `changed_by: "system"`
- Delta capped at ±5 per daily pass; `get-autonomy` surfaces trend and scored action count

The scorer reads rows with `scored_by` set and at least one non-null flag, and `outcome NOT IN ('expired', 'shadow_evaluated')`: `findAllScored` filters in SQL, and `countScored` applies the same evidence filter. That leaves out sampled-pool rows until the principal grades them, coordinator-resolved rows and dead-lettered judge replies (all flags null), and shadow-draft rows (see below).

See `src/autonomy/scoring-pass.ts`, `src/autonomy/action-log-repo.ts`, and ADR-018.

The `autonomy_history` table from Phase 1 is the exact foundation Phase 3 writes to. Phase 3 gets its own design doc when the time comes.

### Shadow-draft evaluation (counterfactual record, ADR-029)

When `ceo-inbox` triages a message but punts (Seen / Urgent / Stuck), it may silently
generate a **non-surfaced, non-sent** shadow draft and store it in OKF. High-sensitivity
threads (board, investors, legal, spouse — KG sensitivity tier) are **included** in shadow
capture, not excluded. When the sent-mail observer later reconciles against the CEO's
actual send, it judges `(shadow draft, actual sent reply)` pairs in chunks of 8 (up to 40
pairs per run, the chunks run concurrently) via `ctx.infraLlm.extract()` on the fast tier
with reasoning off, asking whether
the shadow draft reached the same substantive decision/recommendation as the actual send.
Each chunk is parsed all-or-nothing on its own, so one bad response holds back only its
own pairs. It then writes a **pre-scored** `autonomy_action_log` row:

| Field | Value |
|---|---|
| `competence_flag` | `1` if the LLM judged the shadow draft equivalent (same substantive decision/recommendation) to the actual send; `0` if it diverged |
| `commitment_flag` / `compatibility` | `null` |
| `scored_by` | `'shadow-reconciler'` — `findUnscoredTerminal` skips it |
| Markers | `skill_name: 'shadow-draft-eval'`, `action_risk: 'none'`, `payload.shadow: true`, `outcome: 'shadow_evaluated'` |

**These rows do not feed the Phase 3 score** (amended 2026-10-19, #2191).
`countScored`, `findAllScored` and the error-rate guard all leave out
`outcome = 'shadow_evaluated'`. Shadows are drafted only for messages Curia chose to
punt, so a disagreement mostly says the punt was right, not that an action was wrong; and
in prod 11 of the first 15 judged pairs disagreed, with at least 3 of those from pairing or
judge artifacts. The rows stay in the table as draft-quality evidence for the learning
checkup. Shadow drafts never create approvals or notifications.

**Pairing (#2195).** A shadow pairs with the earliest same-thread send at or after its
capture (2-minute skew allowed) and no more than 72 hours after it
(`SHADOW_SEND_WINDOW_SEC`). Each send answers at most one shadow, the one captured
closest before it. An earlier shadow on the same thread is not scored against the same
reply a second time. It is stamped `superseded_at` / `superseded_by` and never paired
again, so a later follow-up can't stand in for its reply. A failed stamp is logged
(`shadow_supersede_failed`) but does not hold the watermark. A shadow with no send in
its window retries on later runs and is TTL-swept after 7 idle days. Learning-checkup readouts of rows judged before #2195 can
include a send days after capture, or two shadows scored against one reply.
