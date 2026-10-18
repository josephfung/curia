# Tone and style — design

Rework how the office identity describes the way Curia sounds. The operator writes a few
lines describing it, usually starting from a template. The Detail slider stays and becomes
concrete per-channel length limits. Decision posture and the directness slider go away,
and the setup wizard asks for an autonomy level instead. Every agent other than the
coordinator gets the identity block too, in a "writes-as" form.

Supersedes the tone and decision-style parts of [spec 13](../specs/13-office-identity.md).
That spec is updated in PR 2.

## Problem

In a production deployment, Curia's Signal messages and emails read as verbose and generic.
The operator had set Detail near "Brief", chosen three tone words, and added standing
preferences asking for concise messages. None of it made a visible difference. A concrete
preference, a nickname to use for the principal, is followed reliably, so the identity block
does reach the coordinator.

`OfficeIdentityService.compileSystemPromptBlock()` renders all of the tone configuration as
three sentences, for example:

```
**Communication style:**
Your tone is candid and warm and direct.
Keep responses as brief as possible; omit context unless asked.
State positions plainly; avoid softening language.
```

The causes, roughly in order of weight:

1. **Adjectives are the weakest style signal.** A list of tone words gives the model nothing to
   imitate, so it falls back to its default register. The nickname rule works because it is
   a concrete, checkable substitution. "Be concise" is a judgment the model makes against
   everything else in the prompt.
2. **Position.** The block opens a long system string. Everything else comes after it:
   security, contact details, the coordinator YAML, skill bodies, roster, autonomy, date
   guardrail, time and turn budget. The per-turn guidance at the head of the user message
   is far closer to generation, and it has no length guidance. Its only tone cue is the
   hard-coded "warm" in item 3.
3. **The prompt demonstrates a different voice.** The only concrete sentences in the
   prompt are neutral-polite. Examples are coordinator.yaml "I've split this into a few
   parts; I'll report back in about 15 minutes", the non-principal turn guidance's "short,
   warm acknowledgment", and meeting-debrief's "brief, warm debrief prompt". Information
   rules also push for completeness, e.g. "Tell the principal what you know and the
   current state of things".
4. **The settings contradict each other.** `decisionStyle.internalAnalysis: proactive`
   (the default) renders as "surface insights without being asked". A brief Detail setting
   renders as "omit context unless asked".
5. **Content nobody needs.** Two production emails to the principal (2026-10-01 and
   2026-10-18) were long for a different reason than tone. One explained the steps to come
   ("Once I have them, I'll match each transaction…") and read its own job instruction
   back ("I won't process anything until I hear back"). The other listed what wasn't
   there ("No conflicts, nothing before 8 AM or after 7 PM, no travel", "No pending
   approvals", "That is the whole of it."). No setting addresses either habit, and a
   length limit alone cuts facts as readily as filler.
6. **Specialists never see the block.** `buildBaseSystemPrompt()` gives the identity block
   to the coordinator only (`agent-assembly.ts`: `officeIdentityService: isCoordinator ?
   … : undefined`). Some specialists message the principal or third parties directly with
   `signal-send` or `email-send`, typically a deployment's custom agents, such as a daily
   digest. Others write text the coordinator relays: `meeting-debrief` prompts and `ceo-inbox`
   urgent escalations. All of them write with no tone, length or standing preferences.

### What the current fields contribute

| Field | Read by | Verdict |
|---|---|---|
| `tone.baseline` (1–3 words) | the identity block, as "Your tone is X and Y and Z." | Replace with a written description. |
| `tone.verbosity` (Detail slider) | the identity block, as one of four sentences | Keep. Render as concrete per-channel limits. |
| `tone.directness` | the identity block, as one of four sentences | Remove. Register belongs in the description. Calibrated uncertainty is honesty, not personality, so it becomes a fixed code-owned line. |
| `decisionStyle.externalActions` | the identity block only; no gate or skill reads it | Remove. The autonomy band already owns act-vs-ask, more precisely, and the two can contradict each other (`proactive` vs `approval-required`). |
| `decisionStyle.internalAnalysis` | the identity block only | Remove. Its one distinct idea, volunteering observations, is a style choice. As a separate knob it contradicts the Detail setting. |

## Data model

```ts
interface OfficeIdentity {
  assistant: { name: string; title: string; emailSignature: string };
  tone: {
    /** How the assistant sounds, in the operator's words. 1–800 chars. */
    style: string;
    /** Detail slider. 0 = tersest, 100 = most thorough. Unchanged. */
    verbosity: number;
  };
  behavioralPreferences: string[];
  constraints: string[];
}
```

**Naming.** In Curia, "voice" already means the voice-call channel (`VoiceRuntime`,
ADR-038). It also covers the principal's own writing voice (`voice-learn`,
`ExecutiveProfile.WritingVoice`). The new field is `tone.style`, and the console labels it
**Tone & style**. Do not call it "voice" in code or UI.

**No separate samples field.** Example lines are the strongest style signal a model gets,
but asking operators to write good ones is a real adoption barrier, and a second list
editor makes the page harder to use. Instead, the starter templates (see Console) each end
with one example line written by us, e.g. `Sounds like: "Done. Thursday's call is now at
3."` Operators get a working example without writing one, and can edit or add lines in the
same text area. The renderer passes the text through verbatim.

**Removed:** `tone.baseline`, `tone.directness`, `decisionStyle`, and
`BASELINE_TONE_OPTIONS`. The console's tone-word list becomes starter templates (see
Console).

**Validation** (`validateIdentity()`):
- `style` must be non-empty after trimming, with at most 800 characters.
- A PUT that carries `baseline`, `directness` or `decisionStyle` is rejected with a clear
  error. The console ships in the same image, so only a stale client sends the old shape,
  and it should fail loudly instead of being silently dropped.

## Migration (lazy, no DB writes)

`office_identity_versions.config` is JSONB, so there is no schema change. The service adds
`normalizeIdentity(raw)` and applies it everywhere a config is read: `loadFromDb()`, the
history route, and `buildDiffSummary()` (both sides, so a legacy-to-new diff reads
cleanly).

For a legacy config (one with no `tone.style`), it does the following:
- **`style`** is built from the old values. The capitalized tone words are joined
  naturally, followed by the directness sentence. For example:
  `"Candid, warm and direct. State positions plainly; avoid softening language."`
- **`baseline`, `directness` and `decisionStyle`** are dropped.

Edge cases:
- **Legacy keys are always stripped.** That holds even when `style` is already present,
  so a half-migrated row never reaches a writer with keys the new validation rejects.
- **No usable tone words** (`baseline: []` passes today's validation) means the default
  style is used.
- **A missing `directness`** contributes no sentence, never a stray fragment.
- **The output must pass `validateIdentity()`.** This matters because
  `behavioral-preferences-update` does `get()`, edit, then `update()`. A normalized config
  that fails validation would break that tool on every call.
- **A unit test** runs edge rows through `normalizeIdentity` and then `validateIdentity`:
  empty baseline, missing directness, missing decisionStyle, and style plus legacy keys.

Nothing is written back at boot. The normalized shape is persisted on the next write:
an operator save, or a `behavioral-preferences-update` call (`changed_by='tool'`, which
spreads the normalized `get()`).

Writing a migration version at boot was rejected for two reasons:
- **Rollback safety.** If PR 2 is reverted, the old code reads `tone.baseline` and the
  other legacy fields. A boot-written new-shape row would break the old renderer on every
  deployment. Lazy normalization leaves legacy rows untouched until someone actually edits
  the identity.
- **History noise.** Every deployment would get an unrequested version in its audit trail.

It is not about `isIdentityConfigured`, which checks for *any* `wizard`/`api` version and
so is unaffected by later rows. A migration row must still never use `wizard` or `api`
as its `changed_by`, because that would mark a never-configured deployment as configured.

`DEFAULT_OFFICE_IDENTITY` moves to the new shape. It gets a neutral `style` matching the
old `warm, direct` default, ending with an example line like the templates.

Migrated configs get no example line, since we can't write one in the operator's voice.
The PR 2 CHANGELOG entry and the Personality page point operators at the templates.

**Behavior change for upgraders:** `internalAnalysis: proactive` ("surface insights without
being asked") is not carried into the generated style. The CHANGELOG says so. An operator
who wants it adds it to the style text.

## Rendering

### Coordinator (and voice calls, via the existing `identityBlock` provider)

```
## Identity & Communication Contract

**Hard constraints (non-negotiable):**
- <constraint>

**Who you are:**
You are <name>, <title>.

**How you sound:**
<style>
Match the register of any example lines above, not their content.

**Length:** <band rule>
Say what is there, not what isn't, and don't explain your own next steps or repeat your instructions.
Whatever your tone, say plainly when you are unsure or don't know something.

**Standing preferences:**
- <preference>
```

**Decision posture** is gone. The "match the register" line is fixed text. It stops the
model from reusing a template's example sentence word for word.

**Bad tone data never becomes prompt text.**
- **The renderer checks the tone fields.** If `tone.style` is not a non-empty string, or
  `verbosity` is out of range, it logs at error and omits the **How you sound** and
  **Length** sections. Interpolation would otherwise write "undefined" into every agent's
  block without a log.
- **Constraints always render.** Hard constraints, **Who you are** and standing
  preferences render regardless. Throwing would trip the existing omit-the-whole-block
  path in `buildBaseSystemPrompt()`, which would also drop the hard constraints, and after
  PR 4 for every agent.

The content line is fixed, code-owned text in every band, from the two production emails
above (Problem, cause 5). It removes words that carry nothing, so it shortens without
dropping a fact. It is not an absolute ban: an empty calendar is worth saying when the
principal asked about it. PR 3 adds it with the length table; 40f and 40g measure it.

The honesty line is fixed, code-owned text, so no style description can talk the model
out of calibrated uncertainty. It replaces what the low end of the directness slider did.

### Length bands

The Detail slider maps to per-channel limits. The four band boundaries stay as they are.
The numbers are starting points: PR 3 calibrates them against the scenarios.

| Band (verbosity) | Signal / SMS / Slack | Email | Voice call |
|---|---|---|---|
| ≤ 25 | 1–2 sentences. The answer or outcome only. | Under ~80 words. No warm-up line, no closing summary. | One sentence. |
| 26–50 | 1–3 sentences. | Under ~150 words. | 1–2 sentences. |
| 51–75 | Short paragraphs, as the situation needs. | Under ~250 words. | 2–3 sentences. |
| > 75 | Thorough; context included. | Thorough; context included. | A few sentences, then offer more. |

The channel-to-row lookup is an explicit map with a unit test. A reply channel with no row
(`http` console chat, `cli`, `calendar`) gets no length reminder. It is never given a
guessed limit, and the lookup never renders an empty or undefined value.

Every band ends with the same exception: "Go longer only when the principal asks for detail
or the content itself needs the space (six meetings are six lines)." Without it, brevity
drops required content, such as recap items.

### Per-turn reminder

Style is not enforceable in code, so under [ADR-046](../adr/046-agent-behavior-fix-placement.md)
the highest rung that applies is injection with its trigger. Turn guidance gains one line
naming the current reply channel's limit, e.g. "This reply
goes out on Signal: 1–2 sentences." Turn guidance is the most salient position available,
and it sits in the user message, so it does not split the cached system prefix (#1959).
`renderTurnGuidance()` only takes static keys today. The line needs the band and the
channel, both of which the coordinator's runtime already has: the task's `channelId` and
the identity service. So the runtime renders it, with nothing new on the bus. That follows
the backlog line's split, where the bus carries data and the runtime renders the text
(`runtime.ts`). Add its text variants to `TRIGGER_GUIDANCE_MARKER_SOURCES`.

The reminder applies only to turns whose final response is delivered on a channel.
Scheduler turns get none: their response goes nowhere (`SCHEDULER_DELIVERY`). Proactive
sends through `signal-send` or `email-send`, from any turn, rely on the identity block's
channel table.

### Specialists

Every agent gets the block. `agent-assembly.ts` passes `officeIdentityService` to all of
them, not only the coordinator. There is no manifest flag (YAGNI): an agent that needs to
opt out can get one when it exists. Core and deployment agents can't be told apart at
runtime anyway, because a deployment's image copies its `custom/agents/` into the same
`agents/` directory.

For specialists, the block renders in **writes-as** mode, because the agent's own YAML
already says who it is ("You are the Meeting Debrief Specialist"). It is a separate method
(`compileWritesAsBlock()`), not an optional parameter on `compileSystemPromptBlock()`.
With a separate method, any harness that stubs the service fails to compile until it
supports the new mode. An optional parameter would let a stub quietly serve specialists
the coordinator's "You are…" block.

**How the mode is chosen.** `buildBaseSystemPrompt()` knows only `agentId`. It calls
`compileSystemPromptBlock()` for the coordinator (the same `agentId === 'coordinator'`
test the date guardrail uses) and `compileWritesAsBlock()` for every other agent that has
the service. The voice runtime's `identityBlock` provider stays on the coordinator method.

**External renderers.** `SYSTEM_PROMPT_SOURCE_CONTEXT_KEYS` (`agent-assembly.ts`) exists
for renderers outside core, such as a deployment's eval harness that stubs the service
from a snapshot. Those stubs must add the new method, and the snapshot gains a writes-as
field. The new method's compile break is how that coupled change gets noticed.

The block reads:

```
**Who you write as:**
Anything you write for the principal or for anyone outside the office goes out from
<name>, <title>, and follows the contract below.
Anything written in the principal's own name (drafts, posts, essays) follows the
principal's voice, not this contract.
Results you return to the coordinator or another agent are not covered; include
everything they need.
```

The rest (constraints, how you sound, length, standing preferences) is identical.
Standing preferences are included on purpose, because a rule about what a daily recap
contains binds whichever agent writes the recap.

The two scoping sentences carry what a per-agent flag would have. Both are fixed text in
the block, so no agent's YAML needs to repeat them.
- **Writing as the principal.** ceo-inbox drafts in the principal's voice from
  `executive-profile-get`, and that must not change. Deployments have more agents like it:
  an essay editor that edits against the principal's writing guide, and a social-media
  agent that drafts replies in the principal's voice. The first scoping sentence keeps
  all of them on the principal's voice. A scenario pins this for ceo-inbox (see
  Measurement).
- **Reporting to the coordinator.** calendar, contacts, research-analyst and diagnostics
  mostly return results to the coordinator. A "1–2 sentences" length limit must not
  shorten a six-meeting result before the coordinator sees it. The second scoping
  sentence keeps agent-to-agent results out of the contract. The specialist cases already
  in the release gate catch a regression.

This revises spec 13's principle "Specialist agents do not have personalities." The new
principle is that the office has one voice, and every agent that writes outward uses it.
PR 4 updates spec 13. With no YAML schema change there is no public API change, so no ADR.

The prompt budget (`src/agents/prompt-budget.ts`) counts only the YAML prompt and SKILL.md
bodies, not code-owned runtime blocks. PR 4 therefore needs no budget change. The block's
size for each specialist is unbudgeted, so the PR reports it.

### Prompt-exfiltration markers

`extractPromptExfiltrationMarkers()` already turns constraints and preferences into Stage 1
markers. **Do not add `style`.** It holds example lines Curia is meant to imitate, so
markers built from it would block good output. A tone description is also a low-value
exfiltration target. Tone was never a marker source, so this removes no existing coverage.

**The block's own fixed text does become markers.** The new block adds fixed,
instruction-like sentences:
- the honesty line
- the content line ("Say what is there…")
- "Match the register…"
- the "Go longer only when…" exception
- the band texts
- the writes-as sentences

Export them as constants and add them to `TRIGGER_GUIDANCE_MARKER_SOURCES`, so injected
guidance stays scanned (#1959).

**Existing gap, file separately.** Markers are built once from the boot-time identity
(`src/index.ts`). The `config.change` handler refreshes only `agentPersona`, so
constraints and preferences edited after boot are not scanned until a restart.

## Console

**Personality page**
- A **Tone & style** textarea with a character counter (800 max). Its placeholder asks for
  a few lines on how Curia sounds, and what it never does.
- **Starter templates** above it, as chips: *Dry & understated*, *Warm & personable*,
  *Crisp & direct* and *Formal*. Clicking one inserts a short description ending in one
  example line, and asks before replacing existing text. These replace the tone-word
  picker. The hint under the field says one example line does more than any adjective.
- The **Detail** slider stays. In PR 3, its preview starts showing the concrete
  per-channel limits for the current band, replacing `verbosityBand()`.
  - **One source for the limits.** The console reads them from the identity API (a
    `lengthLimits` field on `GET /api/identity`, computed from the same table the renderer
    uses), not from a mirrored copy. PR 3's calibration then changes one place.
  - **PR 2** leaves the existing preview in place.
- The **directness** slider is removed, along with `directnessBand()` and
  `directnessReviewDesc()`.

**Posture page**
- The two decision-posture card grids and the "Posture vs autonomy" callout are removed.
- What's left is standing preferences, so the page is retitled **Standing preferences**.
  Keep the route, or redirect it, so existing links work.
- Hint text: preferences are rules; how Curia sounds goes in Tone & style.

**Wizard**
- The tone step uses the templates and textarea.
- The directness slider is removed.
- **Step 5 becomes "Autonomy & preferences".** An autonomy band picker replaces the
  posture cards, so onboarding still asks how independent Curia should be, using the
  setting that actually controls it.
  - **Shared code.** `BAND_META` and `bandForScore()` are extracted from `SettingsPage.tsx`
    (`AutonomySection`) into a shared module, and the picker reuses `PostureCardGrid`'s
    card layout.
  - **Score per band.** Each band card maps to one score. Use the band's lower bound from
    `bandForScore()`, so a picked band never unlocks a higher `action_risk` tier than its
    name suggests.
  - **Pre-selection.** On a re-run, the current band is pre-selected from
    `GET /api/autonomy`. That GET is a **required** load, like `/api/identity` and
    `/api/setup/status`. If it fails, the wizard shows a load error. It never falls back
    to a default band, because submitting a guessed default could quietly lower a real
    score.
  - **Submit order: autonomy first.** The wizard sends `PUT /api/autonomy` (with `reason:
    "Set via onboarding wizard"`, the field the route reads; skipped when the band is
    unchanged) **before**
    `PUT /api/identity`. As soon as a `wizard` identity version exists,
    `isIdentityConfigured()` returns true and the wizard never shows again. If identity
    were saved first and autonomy then failed, the operator could not get back to fix it.
    With autonomy first, a failure leaves the deployment unconfigured and the wizard
    re-runs.
  - **On any failure,** stop before reload, restart and navigation. Stay on the review
    step and show the error naming the failed call.
- The review rows change to match: Tone & style, Detail, Autonomy and Preference, with no
  Directness or Posture rows.

The `setup-status` catalog copy ("Tune tone, working style…") gets checked for wording.

## Measurement

Style cases live in the scenarios suite (`tests/scenarios/cases/40*`, tag `style`). What
code can score, code scores, with the suite's `text` check (a word cap and banned patterns,
on the reply or on one argument of a send). The judge scores the rest against the
fixture's `judge_brief`, which it sees as "The office's configured style":

- **Length** (code): the reply or message stays under the case's word cap.
- **No filler** (code): no exclamation marks, warm-up openers ("Great question", "Here's
  what I found"), or closing offers ("let me know if…"). 40f and 40g add process narration
  and reports of absence.
- **Register** (judge): reads in the configured style.
- **Content kept** (judge, `critical`): a brief reply still carries every required fact.
  It is the only gated behavior in the style cases, so brevity can never be bought by
  dropping content. Length and register are `important`: scored and compared, not gated.

Cases:
- **40a** A Signal reply to a principal question. The specialist's answer is long and
  chatty; its three facts must survive the trim.
- **40b** An email reply from Curia's own inbox to a third party.
- **40c** A scheduled recap sent with `signal-send` (proactive path, no turn reminder).
  Four meetings are four facts.
- **40d** The debrief prompt meeting-debrief writes for the coordinator to relay. It has
  no identity block until PR 4.
- **40e** **A guard case:** a ceo-inbox draft is produced (not refused or escalated) and
  follows the executive voice profile, not the office style. Hard constraints render first
  in the block, so a constraint like "never impersonate the principal" could start
  blocking drafts in the principal's voice. The voice profile is the office style's
  opposite (warm, exclamation marks, "Cheers, Avery"), so the voice the draft follows is
  plain to see.
- **40f** A scheduled email asking the principal for statements, from the 2026-10-01
  production email. It scores process narration and repeated instructions.
- **40g** A scheduled morning brief by email, from the 2026-10-18 production brief. It
  scores reports of what isn't there.

40f and 40g run on the coordinator. In production, the first came from a deployment's
expense-tracker agent and the second from a scheduled job. They are the same kind of
turn: a scheduler task that ends in one `email-send` to the principal.

**Eval snapshots.** Harnesses that render agent prompts from a snapshot of the live
identity block (#261) need a writes-as block field, and must be re-fetched after the PR 2
and PR 4 deploys. Otherwise they score the old block text.

**Setting the identity for a run.** The scenario stack gives agents a read-only view of one
shared `OfficeIdentityService`, and cases run 4 at a time. A per-case identity would leak
into concurrently running cases, so the identity is the run's:
- **A case names a fixture** (`identity: style-brief-dry`, from
  `tests/scenarios/identities/`). Every case in a run must name the same one (or none), and
  a case with a fixture is never in the release gate. `pnpm scenarios --tags style` runs
  the group.
- **The fixture is laid over the database's identity in memory.** The stack's identity
  service returns it from `get()`, so every block still comes from the real renderer, and
  nothing is written to `office_identity_versions`. The assistant's name, title and
  signature stay the database's.
- **The fixture is a brief Detail band** (15) plus dry tone words and the default decision
  style, in today's shape. PR 2 rewrites it as `tone.style`; `judge_brief` stays the same,
  so the judge reads one target in both arms.
- **40a needs a principal with a Signal identity** in the database the run uses.

**When to measure.** Two style-group runs in all:
1. **PR 1** records a baseline. PR 1 changes no prompt, agent or renderer, so its branch
   measures main's behavior.
2. **PR 3** runs one A/B against main, once the style text and the length limits are both
   live. That run answers whether the rework worked. If it shows no gain, we look into
   PR 2 and PR 3 then.

PRs 2, 4 and 5 run no A/B. PR 4's specialist and guard cases are already here (40d, 40e),
and just need to keep passing. Regressions elsewhere are the release gate's job.

### Baseline (PR 1)

`deepseek/deepseek-v4.1-flash` (the production standard tier), 5 runs each, at
`30579897` (this branch before a rebase that brought in only CI changes), on 2026-10-18,
under `style-brief-dry`. About $0.29 and 3 minutes, judge included. PR 1 changes no prompt, agent or renderer, so this is main's behavior. Pass
rates are per behavior; words are each run's reply or message. The `principal` checks in
40c, 40f and 40g were loosened after the run to accept a label hint (`principal#primary`,
which one 40f run used). The saved runs were rescored in code with the new check.

| Case | Content kept | Length | Filler / content | Register | Words |
|---|---|---|---|---|---|
| 40a Signal reply (≤ 40) | 100% | **40%** | 100% | 80% | 55, 34, 31, 47, 58 |
| 40b email, third party (≤ 80) | 100% | 100% | 100% | 100% | 40, 34, 52, 33, 46 |
| 40c scheduled recap (≤ 60) | 100% | 80% | 100% | **40%** | 66, 40, 55, 52, 51 |
| 40d debrief prompt | 100% | 100% (judge) | 100% | 100% | — |
| 40e guard: principal's voice | 100% | — | — | 100% | — |
| 40f request email (≤ 60) | 100% | 100% | **0%** narration | **0%** | 44, 40, 52, 42, 48 |
| 40g morning brief (≤ 90) | 100% | **0%** | **0%** absences | **0%** | 104, 121, 98, 114, 112 |

What it shows:
- **The production emails reproduce.** Every 40f email opens "Time for the monthly
  reconciliation" and closes on "I'll take it from there". Every 40g brief lists what
  isn't there ("No conflicts, nothing before 8 AM or after 7 PM", "Nothing pending my
  approval. That's everything open."). The judge rates the register of both 0%. These
  are the cases with the most room, and the ones the content line targets.
- **Signal messages to the principal run long.** 40a relays a long specialist answer and
  keeps its framing ("Two open items from her reply:"), then adds a closing offer ("Want
  me to draft a reply?"). 40c lists the meetings well but adds commentary, and the judge
  marks it down for register.
- **Email to a third party is already short** under this identity. 40b mostly catches a
  regression.
- **40d copies its example.** All five prompts are near-verbatim copies of
  meeting-debrief.yaml's sample sentence ("…just wrapped up. Any takeaways or follow-ups
  you'd like me to handle?"). The judge rates that dry enough, so 40d can only catch a
  regression. PR 5's removal of the example is what changes it.
- **40e holds.** Every draft is in the principal's voice ("Marcus —", exclamation marks,
  "Cheers, Avery"), with no refusal. It is the guard PR 4 must keep green.
- **Routing noise.** In an earlier run of 40b, one run never asked ceo-inbox, so it put a
  task and a "will follow up" note into the email to Priya. Both arms of an A/B share
  that kind of miss.

## PR sequence

| PR | Delivers | Measurement |
|---|---|---|
| 0 | This design | none |
| 1 | Style cases 40a–40g, the `text` check, judge style brief and run-level identity fixture | baseline |
| 2 | Data model, `normalizeIdentity`, validation, new identity block (style, honesty line, no decision posture), starter templates, console Personality / Posture changes, wizard autonomy picker, identity fixture in the new shape. Docs: spec 13 fields, spec 18 (onboarding: tone and posture steps, `BASELINE_TONE_OPTIONS`), `docs/dev/setup.md` (sliders) | none |
| 3 | Per-channel length table and the content line in the block (explicit channel map); per-turn length reminder; block's fixed lines added to marker sources; calibrate band numbers | A/B vs main, style group |
| 4 | Every agent gets the block: `compileWritesAsBlock()` with the two scoping sentences; spec 13's "specialists have no personality" principle revised; `docs/dev/adding-an-agent.md` drops its directness mention | none (40d, 40e keep passing) |
| 5 | Remove tone directives from prompts: "warm" in turn guidance and meeting-debrief, and the neutral example sentences in coordinator.yaml. Leave information policy, phrased as policy. | none |

PRs 1–5 each update `CHANGELOG.md`. PR 0 is docs/wip only and needs no entry. **PR 2** is
the user-visible change: settings move and the identity API shape changes, so its entry
calls that out.

## Out of scope

- **The principal's own writing voice:** `ExecutiveProfile.WritingVoice`, `voice-learn` and
  the formality slider.
- **The standard-tier model.** If PR 2–3 scores show `deepseek-v4.1-flash` cannot hold a
  written style, that is a separate model evaluation.
- **Double email signatures:** #2138.
- **A "preview a message" button** on the Personality page, which writes a sample Signal
  message from the current settings. It would make tuning the text easier without asking
  operators to write examples. Worth a follow-up issue once PR 2 lands.
