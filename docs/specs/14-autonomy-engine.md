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
| `medium` | 70 | Outbound communications |
| `high` | 80 | Calendar writes, commitments on behalf of CEO |
| `critical` | 90 | Financial / destructive / irreversible actions |

A raw integer (0–100) may be used for precision (e.g. `75` for a skill that should unlock just above `approval-required` but below `spot-check`). Values outside `[0, 100]` produce a validation error at skill load time and prevent startup.

**This field is required in all skill manifests.** Validated at load time (startup rejects missing fields). Enforced at runtime: the execution layer blocks skill invocations when the live score is below the skill's floor.

### Quick reference by capability class

| Capability class | Recommended value | Rationale |
|---|---|---|
| Read / retrieve / summarize | `none` | No external effect — always safe |
| Internal state writes (memory, contacts) | `low` | Affects future behavior but reversible |
| Outbound communications | `medium` | External effect; CEO should have visibility |
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
| `score < 70` | `OutboundGateway.send()` blocks direct outbound dispatch; draft creation remains available as the intended fallback |
| `score >= 90` | Elevated skills callable without per-action CEO confirmation |

The `OutboundGateway` (see [15-outbound-safety.md](15-outbound-safety.md)) is already the natural choke point — adding an autonomy check there requires no architectural change.

### Principal bypass

When a task is **principal-originated** (initiated by a direct CEO message, as determined by `isPrincipalOriginated(taskMetadata)`), both Gate A and Gate B are skipped. The autonomy gate governs *autonomous* behavior; an explicit CEO instruction is its own authorization and must not be blocked by the score the CEO themselves set.

Implementation: the execution layer calls `isPrincipalOriginated()` before evaluating autonomy gates. If the task traces back to a principal message, the gates are logged but not enforced. Bypasses are written to the audit log at `info` level for operator visibility.

Scope: principal bypass applies to Gates A and B only. It uses task **lineage** (`isPrincipalOriginated` on effective standing) — a woken principal-lineage task can inherit it via the ladder at high trust. This is deliberately a *different* notion of "principal" from the elevated-skill gate (`sensitivity: 'elevated'`), which requires a **live principal turn** and is never bypassed or inherited (#1126). Acting *within* CEO-authorized work (a `normal` skill) can reasonably be inherited at high trust; *exercising authority* (an `elevated` skill) needs the human now. See [03-tools-and-execution.md](03-tools-and-execution.md) and ADR-017.

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

`autonomy.gating: band | tier` (`config/default.yaml`) chooses who decides when Curia asks first. It ships as `tier`, the contact-tier policy described above (Gate C's tier veto and the outbound filter's Stage 2.5). Under `band` the score decides, and contact tier only matters when an outsider is steering Curia. See [ADR-049](../adr/049-band-driven-autonomy.md).

### Behavior by band

| Band | Score | Taking on new work | Coordinating | Speaking or committing as the principal | Principal hears about it |
|---|---|---|---|---|---|
| Full | 90+ | Proceeds | Acts | Acts | Digest, notable items only |
| Spot-check | 80–89 | Proceeds, reports | Acts | Acts, after the fact check | Digest |
| Approval | 70–79 | Proceeds, reports | Acts | **Asks first** | Digest, plus the asks |
| Draft | 60–69 | Principal confirms | Drafts | Drafts | Digest, plus the asks |
| Restricted | <60 | Proposes only | Drafts only | Drafts only | Digest |

At every band an outsider steering Curia means the action is held, the integrity rules block, and the fact check runs whenever Curia speaks as the principal. Gates A and B are unchanged and apply on top.

### Gate C under band (`runBandGateC`, `src/skills/execution.ts`)

| Case | 80+ | Below 80 |
|---|---|---|
| KG write from an unknown or blocked sender | escalate (#1290) | same |
| External originator with no tier | escalate (#1059) | same |
| A send (`HUMAN_SEND_SKILLS`) | proceed — the gateway's band review asks all four questions | same |
| Any other action at medium risk or above | ask *purpose* if an outsider (below `trusted`) initiated it; escalate on "steered" | ask *purpose* and *speaks as principal*; escalate on "steered" or "yes" |
| A low-risk action | ask *purpose* if an outsider initiated it | same |
| Judge failure, or the drafting turn's evidence cannot be read | escalate | escalate |

Gate C leaves sends to the gateway because it sees only a truncated description with contact references, while the gateway sees the whole message and its resolved recipients; a hold there raises the same approval. At 80+, a non-send the tier policy would have escalated emits a `gate_proceeded` digest item. Unlike the tier gate, band Gate C also covers system- and agent-originated tasks.

### Send-time review (`BandSendReview`, `src/dispatch/band-send-review.ts`)

Under `band` the outbound filter's `contact-data-leak` rule and Stage 2.5 are off. After the integrity rules and Stage 2 pass, the gateway asks the escalation judge's brief (`src/autonomy/judge-brief.ts`). The judge sees the message, the recipients, the band and the drafting turn's evidence: the turn's tool results read back from the audit log (task → `tool.invoke` → `tool.result`), its task content and progress, and the "Who you serve" block. The evidence is passed beside the message, never written into it, and credentials are redacted before it leaves.

| Send | Questions |
|---|---|
| Principal-directed (a live principal turn) | grounding |
| Everything else, at every band | purpose, speaks as principal, grounding, necessity |

`send-draft` is the exception: a principal-directed draft send (a live turn or an approval) is not reviewed at all, because `send-draft` marks every call `humanApproved` and a stored draft cannot be trimmed; an autonomous one (a woken task) gets all four questions.

| Answer | Effect |
|---|---|
| steered | hold, at every band |
| speaks as principal, below 80 | hold |
| unsupported claims or unneeded disclosures | bounce to the drafter once. On the recheck: at 80+ cut the quoted text, recheck the trimmed message for grounding, send with a `claim_trimmed` digest item, hold if it still fails; below 80 hold |
| judge failure | 80+: send with a `sent_without_review` item, at most five an hour, then hold until a judge call succeeds and email the principal once; below 80: hold. A failure on the recheck of a bounced draft holds. |

A bounce publishes `outbound.blocked`, so a relayed reply goes through the dispatcher's rewrite, and shows the drafter only text quoted verbatim from its message. A hold raises an approval through the send's `holdRecipe` (each send skill replays itself; relayed replies replay through `dispatcher-relay`) and never publishes `outbound.blocked`; a hold with no approval behind it queues a digest item. Sends the principal approved (`humanApproved`), system notifications and sends to the principal alone are not reviewed. A stored draft cannot be trimmed, so a draft the review would trim is held.

Relayed replies skip the dispatcher's tier Gate C (except #1059's missing-tier escalate) and get all four questions at the gateway.

### Sampling and feedback (`src/autonomy/sample-pool.ts`, `src/reports/`)

Sampling runs at every band and is independent of the gating policy. Autonomous actions that went out without the principal seeing them are logged in a pool; a few at a time are shown in the digest; the principal's verdict on them is the strongest evidence the Phase 3 scorer gets. The LLM judge never grades a pooled action.

**The pool.** A pool row is an ordinary `autonomy_action_log` row with `outcome = 'success'`, `scored_by = 'sample-pool'` and all three flags null. `findUnscoredTerminal` skips it (it is already "scored") and `countScored` / `findAllScored` skip it (no flags) until a verdict arrives. The row keeps the tool input when its JSON is 2,000 characters or fewer, plus the signals below, under `payload.sample`. A triage row also keeps the email's subject and sender when the tool's result carried them (`ceo-inbox-archive` and `ceo-inbox-label` return both).

| Written by | Rows |
|---|---|
| Outbound gateway (`HUMAN_SEND_SKILLS` and `dispatcher-relay`) | Every send to anyone but the principal alone, with the band review's signals |
| Execution layer (`isSampledTool`) | Triage tools (`ceo-inbox-archive`, `ceo-inbox-label`, `email-archive`, `email-label`) at any risk, and every tool at medium risk or above except `file-parse`, `web-browser` and `voice-learn` |

Left out: live principal turns, approved re-runs and system notices. The execution layer does not log sends a second time, since the gateway already did. `ceo-inbox-update-folders` is not sampled, because triage pairs it with an archive per message and sampling both would count one decision twice.

**Weights.** A candidate weighs 3 when it speaks as the principal, goes to a first contact (no contact record yet, or one under 24 hours old), was bounced, trimmed or sent unreviewed by the band review, got through Gate C where the tier would have asked (`gateProceeded`), or is triage. Everything else weighs 1. Weights are relative and never zero, so routine actions stay drawable.

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
pairs per run, the chunks run concurrently) via `ctx.infraLlm.extract()`, asking whether
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
