# Tone and style — design

Rework how the office identity describes the way Curia sounds. The operator writes a short
description of the voice and a few sample lines. The Detail slider stays and becomes
concrete per-channel length limits. Decision posture and the directness slider go away.
Specialists that write to the principal get the identity block too.

Supersedes the tone and decision-style parts of [spec 13](../specs/13-office-identity.md).
That spec is updated in PR 2.

## Problem

In production, Curia's Signal messages and emails read as verbose and generic. The
principal set Detail to "Brief" (verbosity 9) and chose `matter-of-fact`, `witty` and `dry`
as tone words. The standing preferences say "Be concise unless detail is explicitly
requested" and "When messaging or emailing, always be succinct." Those settings make no
visible difference. One preference, "use 'boss' instead of his name", is followed reliably,
so the identity block does reach the coordinator.

`OfficeIdentityService.compileSystemPromptBlock()` renders all of the tone configuration as
three sentences:

```
**Communication style:**
Your tone is matter-of-fact and witty and dry.
Keep responses as brief as possible; omit context unless asked.
State positions plainly; avoid softening language.
```

The causes, roughly in order of weight:

1. **Adjectives are the weakest style signal.** "Witty and dry" gives the model nothing to
   imitate, so it falls back to its default register. The "boss" rule works because it is a
   concrete, checkable substitution. "Be concise" is a judgment the model makes against
   everything else in the prompt.
2. **Position.** The block opens a long system string. Everything else comes after it:
   security, contact details, the coordinator YAML, skill bodies, roster, autonomy, date
   guardrail, time and turn budget. The per-turn guidance at the head of the user message
   is far closer to generation, and it says nothing about length or tone.
3. **The prompt demonstrates a different voice.** The only concrete sentences in the
   prompt are neutral-polite. Examples are coordinator.yaml "I've split this into a few
   parts; I'll report back in about 15 minutes", the non-principal turn guidance's "short,
   warm acknowledgment", and meeting-debrief's "brief, warm debrief prompt". Information
   rules also push for completeness, e.g. "Tell the principal what you know and the
   current state of things".
4. **The settings contradict each other.** `decisionStyle.internalAnalysis: proactive`
   (the default) renders as "surface insights without being asked". Verbosity 9 renders
   as "omit context unless asked".
5. **Specialists never see the block.** `buildBaseSystemPrompt()` gives the identity block
   to the coordinator only (`agent-assembly.ts`: `officeIdentityService: isCoordinator ?
   … : undefined`). Some specialists message the principal directly with `signal-send` or
   `email-send`: `digest`, `security-triage` and `t2125-expense-tracker` in curia-deploy.
   Others write text the coordinator relays: `meeting-debrief` prompts and `ceo-inbox`
   urgent escalations. All of them write with no tone, length or standing preferences.

### What the current fields contribute

| Field | Read by | Verdict |
|---|---|---|
| `tone.baseline` (1–3 words) | the identity block, as "Your tone is X and Y and Z." | Replace with a written description plus samples. |
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
    /** 0–3 lines that show the register. Each 1–200 chars, single line. */
    samples: string[];
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

**Removed:** `tone.baseline`, `tone.directness`, `decisionStyle`, and
`BASELINE_TONE_OPTIONS`. The console's tone-word list becomes starter templates (see
Console).

**Validation** (`validateIdentity()`):
- `style` must be non-empty after trimming, with at most 800 characters.
- `samples` holds at most 3 entries, each 1–200 characters with no newlines.
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
  naturally, followed by the directness sentence. For the production config:
  `"Matter-of-fact, witty and dry. State positions plainly; avoid softening language."`
- **`samples`** is set to `[]`.
- **`baseline`, `directness` and `decisionStyle`** are dropped.

Nothing is written back. The normalized shape is persisted on the operator's next save.
Writing a migration version was rejected because of `changed_by`. `isIdentityConfigured`
counts only `wizard` and `api` versions as operator-configured. A version written by the
system would make a configured deployment look unconfigured and send it back to the setup
wizard.

`DEFAULT_OFFICE_IDENTITY` moves to the new shape. It gets a neutral `style` matching the
old `warm, direct` default, and no samples.

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

Lines in your register (match the voice, not the content):
- "<sample>"

**Length:** <band rule>
Whatever your tone, say plainly when you are unsure or don't know something.

**Standing preferences:**
- <preference>
```

The samples sub-block is omitted when there are none. **Decision posture** is gone.

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

Every band ends with the same exception: "Go longer only when the principal asks for detail
or the content itself needs the space (six meetings are six lines)." Without it, brevity
drops required content, such as recap items.

### Per-turn reminder

Style is not enforceable in code, so under [ADR-046](../adr/046-agent-behavior-fix-placement.md)
the highest rung that applies is injection with its trigger. Turn guidance gains one line
naming the current reply channel's limit, e.g. "This reply
goes out on Signal: 1–2 sentences." Turn guidance is the most salient position available,
and it sits in the user message, so it does not split the cached system prefix (#1959).
`renderTurnGuidance()` only takes static keys today. The line needs the band, so it is
rendered by the caller (dispatcher for inbound turns, runtime for scheduler turns) and
passed in the same way as the backlog line. Add its text variants to
`TRIGGER_GUIDANCE_MARKER_SOURCES`.

This covers the reply channel only. Proactive sends through `signal-send` or `email-send`
rely on the identity block's channel table. PR 3's A/B decides whether the reminder pays for
its tokens.

### Principal-facing specialists

Agents opt in with a manifest flag:

```yaml
office_identity: true
```

`agent-assembly.ts` passes `officeIdentityService` to the coordinator and to any agent with
the flag. For specialists, the block renders in **writes-as** mode, because the agent's own
YAML already says who it is ("You are the Meeting Debrief Specialist"):

```
**Who you write as:**
Anything you write for the principal or for anyone outside the office goes out from
<name>, <title>, and follows the contract below.
```

The rest (constraints, how you sound, length, standing preferences) is identical.
Standing preferences are included on purpose, because rules like "Daily recap emails should
be succinct…" bind whichever agent writes the recap.

Opt-ins:
- **core:** `meeting-debrief` and `ceo-inbox`.
- **curia-deploy:** `digest`, `security-triage` and `t2125-expense-tracker`.

**`ceo-inbox` is the exception that needs care.** Its drafts are written in the
*principal's* voice from `executive-profile-get`, and that must not change. ceo-inbox.yaml
gains one sentence scoping the block: drafts and replies in the principal's name use the
executive voice profile, and the identity block covers only what ceo-inbox writes for
Curia (escalations, summaries). A scenario pins this (see Measurement).

This revises spec 13's principle "Specialist agents do not have personalities." The new
principle is that the office has one voice, and every agent that writes outward uses it.
The flag is an agent YAML schema addition, which is a public API surface. Both the
schema addition and the reversed principle go in an ADR that lands with PR 4.

`tests/unit/agents/prompt-budget.test.ts` budgets ceo-inbox and meeting-debrief. Check
whether it counts injected preamble blocks. If it does, raise those two budgets by the
block's measured size in PR 4 and say so in the PR, rather than trimming the block to fit.

### Prompt-exfiltration markers

`extractPromptExfiltrationMarkers()` already turns constraints and preferences into Stage 1
markers. Add the sentences of `style`, gated at the same normalized length. **Never add
`samples`.** They are text Curia is meant to imitate, so making them markers would block
good output.

The markers are built once at boot from the identity (`src/index.ts`). Check whether an
identity hot-reload refreshes them. If it does not, file it separately, since that gap
predates this work.

## Console

**Personality page**
- A **Tone & style** textarea with a character counter (800 max). Its placeholder asks for
  a few lines on how Curia sounds, and what it never does.
- **Starter templates** above it, as chips: *Dry & understated*, *Warm & personable*,
  *Crisp & direct* and *Formal*. Clicking one inserts a paragraph, and asks before replacing
  existing text. These replace the tone-word picker.
- A **samples** list (`StringListEditor`, max 3) with the hint: "Two or three lines that
  sound like Curia. They do more than any description."
- The **Detail** slider stays. Its preview shows the concrete per-channel limits for the
  current band, replacing `verbosityBand()`.
- The **directness** slider is removed, along with `directnessBand()` and
  `directnessReviewDesc()`.

**Posture page**
- The two decision-posture card grids and the "Posture vs autonomy" callout are removed.
- What's left is standing preferences, so the page is retitled **Standing preferences**.
  Keep the route, or redirect it, so existing links work.
- Hint text: preferences are rules; how Curia sounds goes in Tone & style.

**Wizard**
- The tone step uses the templates, textarea and samples.
- The directness slider is removed.
- Step 5 "Posture & preferences" loses its posture cards (see Open questions).
- The review rows change to match: Tone & style, Detail and Preference, with no Directness
  or Posture rows.

The `setup-status` catalog copy ("Tune tone, working style…") gets checked for wording.

## Measurement

Add style cases to the scenarios suite, judged with the existing rejudge infrastructure. The
judge sees the identity's `style` and `samples` and scores the following:

- **Length:** within the band's limit for the channel.
- **Register:** matches the style text, e.g. no exclamation marks under a dry style.
- **No filler:** no warm-up openers ("Great question", "Here's what I found"), restated
  asks, or closing offers ("let me know if…").
- **Content kept:** a brief reply still carries every required fact.

Cases:
1. A Signal reply to a principal question, at a brief band and a dry style.
2. An email reply from Curia's own account to a third party.
3. A scheduled recap sent with `signal-send` (proactive path, no turn reminder).
4. A specialist-originated message (meeting-debrief prompt) once PR 4 lands.
5. **A guard case:** a ceo-inbox draft still follows the executive voice profile, not the
   office style.

PR 1 lands these and records a baseline on main. Each later PR is an A/B against main on
the same cases.

## PR sequence

| PR | Delivers | A/B |
|---|---|---|
| 0 | This design | none |
| 1 | Style scenarios and judge rubric; baseline on main | baseline only |
| 2 | Data model, `normalizeIdentity`, validation, new identity block (style, samples, honesty line, no decision posture), console Personality / Posture / wizard changes, spec 13 update | main vs branch |
| 3 | Per-channel length table in the block; per-turn length reminder; calibrate band numbers | with vs without the reminder |
| 4 | ADR for the office-voice principle and the manifest flag; `office_identity: true` flag, writes-as rendering, core opt-ins, ceo-inbox scoping sentence; then a curia-deploy PR opting in `digest`, `security-triage` and `t2125-expense-tracker` | main vs branch, including the ceo-inbox guard case |
| 5 | Remove tone directives from prompts: "warm" in turn guidance and meeting-debrief, and the neutral example sentences in coordinator.yaml. Leave information policy, phrased as policy. | main vs branch |

Each PR updates `CHANGELOG.md`. PR 2 is the user-visible change: settings move and the
identity API shape changes, so it calls that out.

## Out of scope

- **The principal's own writing voice:** `ExecutiveProfile.WritingVoice`, `voice-learn` and
  the formality slider.
- **The standard-tier model.** If PR 2–3 scores show `deepseek-v4.1-flash` cannot hold a
  written style, that is a separate model evaluation.
- **Double email signatures:** #2138.

## Open questions

1. **Wizard step 5.** Drop posture and keep only preferences, or put an autonomy band picker
   there? Autonomy is the knob that actually controls act-vs-ask, so the second option keeps
   the "how independent is Curia?" question in onboarding.
2. **`security-triage` opt-in.** It emails third parties (reporters). Confirm the office
   style is wanted there, or whether it should keep its own, more formal register.
