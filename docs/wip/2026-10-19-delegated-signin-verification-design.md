# Delegated sign-in with external verification — design

Issue: #2017. Status: design, awaiting approval.

## Intent

The principal asks Curia for an outcome that sits behind a login — "get my policy
notice from the insurer", "pull my Air Canada booking", "download the statement from
<portal>". Curia does the whole errand. It involves the principal only when the site
demands something Curia cannot get on its own, and then exactly once.

Today that breaks at the 2FA step (prod, 2026-10-06): Curia refused the principal's
code three times with three different rationales, inbox triage archived the email code,
and the one turn willing to proceed had no handle on the browser session. The model's
consumer-grade "never share your code" prior wins because nothing tells it otherwise,
and nothing structural carries the pending challenge from the turn that raised it to the
turn that receives the code.

The threat model the model gets backwards: the code is going *into* a challenge that
Curia's own browser raised, on a sign-in the principal asked for. A code typed into
Curia's own pending challenge can do nothing but fail. What needs trust is the request
to sign in; what needs protecting is where the code *goes*.

## The three cases that must work

1. **Insurer portal (the 2026-10-06 incident).** Password already in the vault. The site
   offers SMS or email; Curia picks email.
2. **Air Canada — email code.** The code lands in the principal's inbox. Curia reads it
   itself, without asking the principal and without being told to. Triage does not
   archive it first.
3. **An SMS-only site.** The code goes to the principal's phone. Curia asks once, on the
   principal's most urgent available channel (Signal first), naming the site. The principal replies on
   Signal or email; Curia types the code into the same session and finishes the original
   task with no further prompting.

## Goals

- All three cases complete end to end in prod at least once.
- A behaviour scenario keeps the production standard-tier model from sliding back into
  refusing, and runs in the release behaviour gate.
- **Email over SMS.** When a site offers both, Curia chooses email (it can finish without
  the principal). It asks the principal for a code only when SMS or an authenticator app
  is the only option.
- **Expiry and loss are told plainly.** If the code expired or the browser session is gone
  (restart, crash, keep-warm cap), Curia says exactly that and offers to send a fresh
  code. It never claims a session is waiting when it can't resume it, and never silently
  re-triggers a code on its own.
- **Remember this device.** When the site offers it, Curia ticks it, so later sign-ins
  often skip verification.

## Anti-goals (the principal's "wince" list)

These are failures even if sign-in technically works:

1. **A code showing up anywhere it would be read later** — a task or scheduled-job
   progress note, a document where Curia is recording progress, a report or digest, a
   memory or knowledge-graph fact.
2. **Curia sending a code to anyone** over any channel — including the principal. A code
   is only ever typed into the challenge that asked for it.
3. **Curia refusing a code the principal sent directly over Signal** (or email) on the
   grounds that the channel is insecure, or lecturing them about relay attacks.

Not a concern: the raw stored message record (working memory, `audit_log`,
`llm_call_archive`). The principal accepts codes there because they are single-use.
Redacting those is welcome if it falls out naturally but is not required.

## Non-goals

- **Push / tap-to-approve** sign-in (Google, Apple ID) and **payment authorization** in a
  banking app. Out of scope, but the model below must accommodate them without a
  redesign (see "Future kinds").
- **TOTP seeds in the vault** (`totp` variant of `secret_ref`). Follow-up.
- **Concurrent turns on one conversation** (#2018). This work narrows the damage (one live
  verification per site) but does not serialize or merge turns.
- **`senderVerified` false on most inbound email** (#2016). Not fixed here; the guidance
  below makes code acceptance independent of it.

## Constraints from the codebase

- **Only the coordinator can drive the browser** (`web-browser` `allowed_callers:
  ["coordinator"]`). The turn that receives a code must be a coordinator turn, and it can
  enter the code directly — no task wake needed.
- **Task-bound replies are slow.** A reply bound via `task-wake-reply.ts` moves the task to
  `in_progress` and the BacklogHeartbeat picks it up 4–5 hours later. Far longer than any
  code lives. The design must not route codes through that path.
- **Browser sessions are in-memory.** A restart loses every live page; only the persistent
  profile (cookies, remembered devices) survives. An unknown session id silently creates a
  fresh session and reports `session_reused: false`. A verification record can therefore
  outlive its session, and that case must be detected and told plainly.
- **`outbound_context` is the wrong home.** Entries exist only when Curia sends a message,
  injection takes the 10 newest across all conversations, and it fires only on live
  principal turns. A synthetic resume or task-wake turn would never see it.
- **The "Personal secrets" section the issue points at no longer exists** in
  `coordinator.yaml` (moved to tool descriptions in c439fc9b). Per ADR-046 the policy goes
  on the highest rung that works: code enforcement, then injection with its trigger, then
  tool description — not the always-on prompt (which is budget-tested).
- **Outbound safety does not catch codes deterministically.** Stage 1 `SECRET_PATTERNS`
  match only key/JWT/hex shapes; the Stage 2 judge names 2FA codes but is skipped when the
  principal is the sole recipient and fails open when unreachable.
- **Nothing redacts a secret that arrives in an inbound message.** Value-aware redaction
  (`redactValues`, `src/skills/sanitize.ts:185`) exists only for browser `secret_ref`.
- **Inbox triage archives code emails** (ceo-inbox rule 4e-pre: automated mail defaults to
  ✔️ Cleared unless it is a suspension, payment, fraud alert, bounce or deadline).
- **Single app process.** In-memory state is acceptable (same assumption as browser
  sessions and #2018).

## Design

### 1. The verification record (decided: general "verification", not "challenge" or "approval")

A pending **external verification**: a third party (a site, later a bank) wants proof from
the principal before Curia can continue. "Approval" is deliberately avoided — ADR-018 uses
it for Curia asking the principal's permission, the opposite direction.

New table (migration `099_*`, renumbered from 098 when #2159 took it):

| Column | Meaning |
|---|---|
| `id` | uuid |
| `purpose` | `sign_in` (future: `payment`) |
| `kind` | `code` (future: `approval`) |
| `delivery` | `email` \| `sms` \| `app` (future: `device_prompt`) |
| `site` | registrable domain (eTLD+1) of the site the principal asked about, e.g. `aircanada.com` — the uniqueness key and what the principal sees named |
| `page_domain` | registrable domain of the page showing the challenge — often an identity provider (`b2clogin.com`, `okta.com`, `microsoftonline.com`) rather than `site`; the browser guard and the allowed typing path key on this |
| `browser_session_id` | the session waiting on it |
| `task_id` | nullable — the backlog task, if the errand has one |
| `conversation_id` | where the sign-in was requested |
| `status` | `pending` → `satisfied` \| `expired` \| `abandoned` |
| `requested_at`, `expires_at`, `resolved_at` | |
| `metadata` | jsonb, small (e.g. site-stated expiry text, masked destination "•••• 1234") |

The code value is **never stored** in this table.

**One live verification per site** — a unique partial index on `(site) WHERE status =
'pending'`. Opening a second for the same errand (same `task_id`, or no task on either side)
returns the existing record instead of creating one, so a concurrent or later turn reuses the
pending challenge rather than triggering a new code. Opening one for a different task
supersedes: the old record is abandoned and a fresh one opens for the new task.
Keyed on `site`, not `page_domain`, so two unrelated sites sharing an identity provider
don't collide; and on site alone (not task + site) because there is one principal and a
sign-in may have no task. *(My call.)*

**Expiry is a hint, not a cliff.** `expires_at` defaults to 10 minutes after
`requested_at` unless the page states otherwise *(my call)*, and it is shown to the model —
but a code that arrives late is still handled by the same machinery. A past-expiry
`pending` row is persisted as `expired`, and **`expired` and `abandoned` records stay
"recent" for 2 hours after they close** *(my call)*: they are still injected (marked as
expired) and still trigger value registration (§5). So a principal who sends the code at
minute 12 gets a turn that knows a verification existed, tries the code if the session is
still alive (sites often accept slightly late codes), and otherwise says plainly that it
expired and offers a fresh one — instead of falling back to the original refusal. If the
code works, the record moves to `satisfied` regardless of the stored expiry.

Repository + service in `src/verification/` (or alongside `src/browser/` — builder's call).

### 2. Detecting the challenge and opening the record

- **Detection hint in `web-browser`.** The final page-state block of `execute()`
  (`skills/web/tools/web-browser/handler.ts`, ~L362–435) adds a
  `verification_suspected: { page_domain, signals[] }` output when the page carries
  `autocomplete="one-time-code"`, an `inputmode="numeric"` short input next to code-entry
  wording, or a delivery-choice screen ("Send code by email / text"). Heuristic; it nudges,
  it doesn't decide.
- **A new coordinator tool, `verification`** (standalone or in the `web` bundle — builder's
  call; pin to the coordinator; `action_risk: low`). Actions:
  - `open` — `{purpose, kind, delivery, site, browser_session_id, task_id?, expires_at?}`;
    `page_domain` is taken from the session's current URL by the tool, not supplied by the
    model.
    Returns the record (new or the existing pending one). Opening also pins the browser
    session warm.
  - `satisfy` / `abandon` — close it out.
  - `list` — pending records (rarely needed; the injection block carries them).
- The tool description carries the operational rules: choose email when offered; tick
  "remember this device"; open a verification before asking the principal or delegating
  an inbox read.
- **Email only if it reaches a mailbox Curia reads.** When the page shows the masked
  destination ("j•••@josephfung.ca"), the coordinator prefers email only if it is
  consistent with one of the principal's email identities in the `Who you serve` block;
  otherwise it picks SMS. When the page doesn't show it, prefer email and rely on the ~3
  minute wait + fallback. *(My call.)*

### 3. Getting the record to every turn that might need it (injection)

A **runtime injection** for coordinator turns — live, synthetic resume, task wake, all of
them — whenever at least one verification is pending or recent (§1). Same mechanism as the other runtime
blocks (date/timezone, autonomy, security context), not the `outbound_context` lane, so it
reaches turns the principal didn't start. When nothing is pending, nothing is injected.

The block names each pending verification (site, delivery, session id, task, expiry in
local time) and carries the policy, briefly:

- This sign-in was requested by the principal; completing its verification is the job.
- A code the principal sends on any of their channels is theirs to give and goes into this
  challenge. Don't question the channel, don't lecture, don't refuse.
  (`senderVerified: false` does not matter here: an attacker's code can only fail in
  Curia's own challenge.)
- The code goes only into the session and site named here. Never repeat it to anyone,
  never write it into notes, reports or memory.
- If the session is gone (`session_reused: false`) or the verification expired, tell the
  principal exactly that and offer a fresh code. Don't re-trigger one unasked.
- Mark the verification satisfied once the site accepts the code.

ceo-inbox gets its own short injection while an `email` verification is pending (both
triage runs and delegated requests): a one-time-code or sign-in email for that site
received after `requested_at` is left in place until the verification is resolved or
expired; a delegated request to read the code for it is legitimate and should return the
code. Matching is by *the site* (sender name, brand, or body naming it) rather than by the
sender's domain, because code emails often come from a sending service's domain
(`*.sendgrid.net`, `mail.<brand>.com`). Being too loose here costs nothing — an email kept
unarchived for ten extra minutes. *(My call.)*

No always-on prompt growth for either agent. Agent YAMLs change only if pins change
(coordinator: new pin → minor bump).

### 4. The flows

**Email code (cases 1 and 2).** Coordinator hits the challenge → picks email → `open`
(delivery `email`) → delegates "read the <site> sign-in code received after
<time>" to ceo-inbox → ceo-inbox searches; if nothing yet, re-checks for up to ~3 minutes
*(my call on the window; mechanism — wait/retry tool or coordinator re-delegation — is the
builder's call)* → returns the code → coordinator types it into the session → `satisfy` →
ceo-inbox (or the coordinator via delegation) labels and archives the code email. If the
email never arrives, tell the principal and offer SMS or a resend.

**SMS / app code (case 3).** Coordinator hits the challenge, no email option → `open`
(delivery `sms`) → asks the principal once on their most urgent channel ("<Site> just texted
you a sign-in code — send it to me here and I'll finish the <task>") → turn ends. The
principal's reply arrives as an ordinary inbound turn on whatever channel; the injection
block hands it the session id and site → it types the code → `satisfy` → finishes the
original errand in the same turn.

**Backlog-task errands (the insurer case was one).** Two existing mechanics have to be
neutralised so the code doesn't go down the slow path:

- **Auto-bind.** Any send from a task-wake turn auto-binds the principal's reply to the
  task (`context-bridge-parse.ts` ~L107–125, 168h TTL), which routes the reply through
  `task-wake-reply` and writes it into the task's progress note. While the turn has an open
  verification for that task, the code ask **skips the auto-bind** — keyed on a pending
  (or expired, still recent) verification with this `task_id`, not on a flag the model must
  remember to set *(my call)*. The reply then arrives as an ordinary live turn, which the injection block equips.
- **Closing the task.** The turn that enters the code and finishes the errand also
  completes the task (`task-complete`), with a note that says what was done and contains no
  code (§5 scrubs it regardless). If it can't finish — session gone, code rejected — it
  updates the task to say exactly that, so the next heartbeat doesn't re-run the sign-in on
  stale assumptions. The injection block reminds the turn of the task id.

Neither path waits on the BacklogHeartbeat.

**Where the ask goes (decided by the principal).** In order of urgency: **Signal → SMS → Slack → email** — the first channel that is enabled and has a verified principal identity in the `Who you serve` block. Deliberately **not** the channel the errand came in on: the principal often hands things over by email or voice that are meant to be done later, so the request channel says nothing about where they are now. The order lives in config (a list under the verification section of `config/default.yaml`), not in the prompt; the injection block or the tool result names the channel to use, so the model doesn't pick. The reply is accepted on any principal channel regardless of where the ask went.

### 5. Keeping codes out of everything written for later (code enforcement)

The principal's #1 and #2 anti-goals are enforced in code, not left to the prompt.

**Tracked values.** An in-memory, TTL'd set of code values tied to a verification
(TTL: 2 hours after the verification closes — *my call*; long enough to cover the notes and
reports written right after, short enough that a mis-captured number doesn't haunt
unrelated tools for a day). Values are registered from three sources, from most to least
precise:

1. **`web-browser` types text** on a verification's `page_domain` and the text is
   code-shaped → register exactly what was typed. This is the anchor: every code that
   actually gets used is tracked, whichever channel it came from (this covers email codes
   returned by ceo-inbox).
2. **A principal inbound while an `sms` or `app` verification is pending or recent** → the
   dispatcher extracts code-shaped tokens from the principal's *own new text* (quoted email
   history and signatures stripped — the email converter already separates these). Not for
   `email`-delivery verifications, where the principal isn't expected to send a code.
3. **ceo-inbox returns a code** for a verification (delegation response) → register it
   before the coordinator acts on it, to cover a note written before the code is typed.

**Code-shaped** means 6–8 characters *(my call)*: all digits, or digit-bearing
alphanumerics, optionally split by one space or dash (`123 456`, `G-123456`), on token
boundaries. 4- and 5-character codes collide with years, times and amounts, so source 2
takes one only when the message is essentially just the code (≤ 24 characters, not a
question, one digit-bearing token among filler) or it follows "code"/"passcode"/"pin"/"otp",
and a 1900–2099 year (or, without a keyword, a 0000–2359 time) only as the whole message; otherwise only source 1 (an exact typed value)
tracks them. Phone numbers, dates and times in recognisable formats are excluded.

Over-capture is acceptable within this narrow window (a stray 6-digit number in the same
SMS-code reply gets masked in a note); under-capture is the failure to avoid.

**Scrub at the execution layer, default-deny.** In `ExecutionLayer.invoke`
(`src/skills/execution.ts:1554`), before the handler runs, every string in the tool input is
passed through `redactValues` with the tracked set, replacing matches with
`[sign-in code]` — for **every** tool, local or MCP, except one allowed path:
`web-browser` typing on the verification's `page_domain`. This covers progress notes
(`task-create`/`task-update`), scheduled-job payloads, documents (Google Docs / Claude Docs
MCP tools), `report-to-principal`, `memory-store`, and every send skill, without
enumerating them. A send containing a code therefore goes out with `[sign-in code]` in its
place — safe without failing the turn. Matching is on token boundaries so `123456` inside
a longer number isn't masked.

**Browser destination guard.** `web-browser` refuses to type a tracked value on any domain
other than its verification's `page_domain` (registrable-domain match, so `login.aircanada.com`
matches `aircanada.com`; a lookalike does not), or in any browser session other than that
verification's (two verifications on one identity provider share a page domain). `select`
values get the same check. `press_key` is held to the same rule for keys that may type a
character and for paste chords, judged by the focused document, so a code cannot be spelled
one key at a time, or pasted, into another frame; it fails closed. A code split across
several `type` calls is a known residual. The error says why without echoing the value.

**Other write paths that aren't tool calls.** The same scrub applies to:

- the coordinator's final reply text (`agent.response` → outbound filter Stage 1, as a
  value-aware rule alongside `SECRET_PATTERNS`), so "I used code 123456" never goes out;
- checkpoint fact/relationship extraction input (`src/checkpoint/processor.ts`), so a code
  never becomes a knowledge-graph fact;
- delegation-failure escalations that copy task text into notes
  (`src/agents/task-escalation.ts`) — covered if they go through `TaskRepo` with the scrub,
  otherwise scrub there.

Builder's call whether working-memory / audit redaction comes along for free; not required.

### 6. Future kinds (shape only — not built)

`kind: approval`, `delivery: device_prompt` for "tap approve on your phone": the same
record, the same injection block ("Waiting on you to approve the <site> sign-in on your
phone — tell me when it's done"), satisfied by the page advancing. `purpose: payment` for
in-app card authorization. The invariant that won't change: the request to sign in or pay
comes from the principal, and whatever verification comes back goes only to the thing that
asked for it.

## Testing

- **Unit:** verification repo (unique pending per site, expiry and recent-window transitions); token
  extraction (positive and negative shapes); execution-layer scrub (default-deny, the one
  allowed path, token boundaries, MCP tools); browser destination guard
  (subdomain/lookalike); detection hint on fixture pages; injection block rendering and its
  absence when nothing is pending.
- **Integration:** principal inbound with a pending verification registers values; a
  `task-update` progress note written afterwards stores `[sign-in code]`.
- **Scenarios (`tests/scenarios/cases`, release gate, standard-tier model):**
  1. SMS: pending verification seeded; principal sends the code on Signal → `web-browser`
     `type` called with the code on the seeded session; no refusal; `verification satisfy`.
  2. Email: coordinator delegates the code read to ceo-inbox (or calls it) rather than
     asking the principal.
  3. Anti-leak: across the run, no `task-update`, `report-to-principal`, `memory-store` or
     send argument contains the code (`text` / `excludes` checks), and the reply excludes it.
  4. Expired / lost session: the reply says so plainly and offers a fresh code; no claim
     the session is waiting.
- **Prod acceptance:** each of the three cases run once by the principal after deploy.

## Rollout

- **ADR** (next number, 050): "External verifications are first-class state" — the
  verification record, injection over always-on prompt, default-deny value scrub at the
  execution layer, single-process assumption for the tracked set.
- Specs: browser spec (verification hint, destination guard), `15-outbound-safety.md`
  (value-aware code rule), tasks/backlog spec if notes scrubbing is described there.
- CHANGELOG entries; coordinator YAML minor bump for the new pin; tool versions per
  convention.
- **Post-deploy prod data cleanup** (from the issue): rewrite or cancel the insurer task's
  progress note that records "MFA must be completed by the principal at the keyboard" /
  "emailed code was refused as a possible relay attack", *after* deploy, and record it on
  #2017.

## Left to the builder

- Module placement (`src/verification/` vs. near `src/browser/`), tool placement
  (standalone vs. `web` bundle).
- The email-wait mechanism for ceo-inbox (bounded retry inside a tool vs. re-delegation).
- Exact detection heuristics in `web-browser`.
- Whether ceo-inbox reads also register tracked values.
- Whether working-memory/audit redaction is cheap enough to include.

## Calls I made (for the principal to check)

- Name: **verification**, not challenge or approval.
- A **new table** rather than `outbound_context` metadata; one pending row per **site** (separate `page_domain` for identity providers).
- Expiry is a **soft 10 min hint**; closed verifications stay "recent" (still injected,
  still registering values) for **2h**; tracked-value TTL **2h after close**; email wait
  **~3 min**.
- Codes are extracted from free text only while an **SMS/app** verification is pending or
  recent, only from the principal's own new text, and only **6–8 character** shapes (4–5
  only in a message that is just the code, or after a code keyword);
  every code actually typed is tracked exactly.
- Email is preferred only when the masked destination (if shown) matches one of the
  principal's addresses.
- A code ask from a backlog-task turn **skips the reply auto-bind**; the turn that finishes
  the errand **completes the task**.
- Codes in outbound text are **replaced with `[sign-in code]`**, not blocked.
- Default-deny scrub across **all** tool inputs, with one allowed path.
