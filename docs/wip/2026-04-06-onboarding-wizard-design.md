# Onboarding Wizard — Design Spec

**Date:** 2026-04-06
**Status:** Draft
**Issue:** josephfung/curia#140
**Branch:** `feat/onboarding-wizard`

---

## Overview

A multi-step onboarding wizard in the Curia web app that guides a new user through configuring their office identity on first run. The wizard can also be re-entered from a Settings nav item to update the identity at any time.

The wizard depends on the Office Identity Engine (spec 13). It assumes `GET /api/identity`, `PUT /api/identity`, and `POST /api/identity/reload` are available.

---

## Design Decisions

### Wizard container: full-screen overlay

The wizard is a `position: fixed; inset: 0; z-index: 60` overlay — the same layering pattern used by the auth wall. It sits above the main app layout (sidebar + content area), so the sidebar is never visible during setup. This gives a focused, mobile-friendly onboarding moment distinct from the main app.

The overlay is dismissed (not navigated away from) when setup completes or when re-entering from Settings.

### Layout: full-bleed with top bar

Each step uses the full screen width with a `max-width: 520px` content column centered horizontally. A thin top bar carries the wordmark and step progress dots. The content area scrolls independently on small screens.

This layout was chosen over a centered card specifically because Step 2 has 30 tone pills that need room to wrap naturally without feeling cramped.

### First-run detection: server-authoritative `configured` flag

`GET /api/identity` gains a `configured: boolean` field in its response:

- `false` — all identity versions in the DB have `changed_by = 'file_load'` (never explicitly configured)
- `true` — at least one version has `changed_by = 'wizard'` or `changed_by = 'api'`

This is a single extra query on the existing `office_identity_versions` table — no schema change needed. It is server-authoritative (works across devices/browsers) and does not require a separate tracking mechanism.

### Default landing screen: Chat

On successful auth, if `configured: true`, the app navigates to Chat (not Knowledge Graph, which was the previous default). The wizard also lands on Chat with a success banner on completion.

---

## API Changes

### `GET /api/identity` — add `configured` flag

**Current response:**
```json
{ "identity": { ... } }
```

**New response:**
```json
{ "identity": { ... }, "configured": false }
```

Implementation: add a single query inside the `GET /api/identity` route handler:

```sql
SELECT EXISTS (
  SELECT 1 FROM office_identity_versions
  WHERE changed_by IN ('wizard', 'api')
) AS configured
```

No new tables, no migrations.

---

## Navigation Changes

A new top-level **Settings** nav item is added to the sidebar at the same level as Chat and Memory. It is collapsible (same pattern as Memory) and starts expanded by default.

```
Chat
Memory  ▾
  ├ Knowledge Graph
  ├ Contacts
  ├ Tasks
  └ Scheduled Jobs
Settings  ▾
  └ Setup Wizard
```

Clicking **Setup Wizard** from the nav calls `navigate('wizard')`, which shows the wizard overlay and sets the active nav highlight on `nav-wizard`. Whether it's a first-run entry or a re-entry, the wizard always opens the same way — the difference is whether fields are pre-filled (re-entry) or at defaults (first run, though defaults match the current identity since it's loaded from the YAML).

---

## Wizard Flow

### Entry points

1. **First run** — after auth wall clears, the app calls `GET /api/identity`. If `configured: false`, the wizard overlay is shown immediately. The main app (sidebar + views) is never shown to the user before they complete setup.
2. **Re-entry** — Settings → Setup Wizard. The wizard opens with all fields pre-filled from the current identity.

### Exit

On successful save:
1. `PUT /api/identity` with `{ identity: <compiled config>, note: 'Saved via onboarding wizard' }`
2. `POST /api/identity/reload` — refreshes the in-memory cache so the new identity is live for the very next coordinator turn
3. Dismiss the wizard overlay
4. `navigate('chat')` — land on the Chat view
5. Show a teal success banner at the top of the Chat view: **"Your assistant is ready."** (auto-dismisses after 4 seconds)

The reload happens *before* the redirect so the identity is guaranteed live when the user sends their first message.

---

## Wizard Steps

### Step 1 — Name your assistant

**Heading:** "What should your assistant be called?"

Fields:
- **Assistant name** — text input, pre-filled with current `assistant.name` (default: "Alex Curia")
- **Title** — text input, pre-filled with current `assistant.title` (default: "Executive Assistant to the CEO")
- **Email signature** — textarea, pre-filled with current `assistant.emailSignature`

All fields required except email signature. Validation: assistant name must not be empty.

---

### Step 2 — Communication style

**Heading:** "How should your assistant communicate?"

#### Tone (pill grid)

All 30 words from `BASELINE_TONE_OPTIONS` displayed as a scrollable pill grid. Pills are ungrouped visually — the natural wrapping provides enough scannable structure without category headers adding density.

- Minimum 1 selection, maximum 3
- At 3 selections, all unselected pills are visually dimmed and non-interactive, with a hint below the grid: "Pick up to 3"
- Selected pills render with `background: var(--primary); color: var(--primary-fg)` (same as active buttons)
- Unselected pills render with `border: 1px solid var(--accent); color: var(--fg-muted)`
- Default selection: `['warm', 'direct']`
- Live preview sentence below the grid updates as selections change: **"Your tone is warm and direct."**

#### Detail level (slider)

- Range: 0–100, default 50
- Left label: "Brief" — right label: "Thorough"
- Maps to `tone.verbosity`
- Live preview: a short sample sentence in an italic blockquote updates as the slider moves, drawn from the same band table used by `compileSystemPromptBlock()`:
  - 0–25: *"Here's the short answer."*
  - 26–50: *"Happy to help — let me know if you'd like more detail."*
  - 51–75: *"Here's what you need to know, plus a bit of context."*
  - 76–100: *"Let me walk you through this thoroughly."*

#### Directness (slider)

- Range: 0–100, default 75
- Left label: "Measured" — right label: "Direct"
- Maps to `tone.directness`
- Live preview sample sentences:
  - 0–25: *"There are a few things worth considering here — it's hard to say definitively."*
  - 26–50: *"I'd lean toward option A, though it depends on your priorities."*
  - 51–75: *"Thursday works. I'll send the invite."*
  - 76–100: *"Do it. The risk is low and the upside is clear."*

#### Decision posture

Three pill/card selectors (not a dropdown) for `decision_style.external_actions`:
- **Conservative** *(default)* — "Verify before acting; flag ambiguity"
- **Balanced** — "Act when confident, flag when uncertain"
- **Proactive** — "Bias toward action; less checking in"

Note: `decision_style.internal_analysis` is not surfaced in the wizard — it stays at the `'proactive'` default from the YAML. The wizard only exposes the external actions posture, which is what users need to reason about.

---

### Step 3 — Anything else?

**Heading:** "Is there anything else we should know?"

- Single optional textarea, large, generous whitespace
- Helper text: *"E.g., 'Always include agenda items in meeting requests' or 'Flag emails from investors as high priority'"*
- The user's input is **appended** to `behavioral_preferences` as a new entry — it does not overwrite the defaults from the YAML. If the textarea is empty, `behavioral_preferences` is left unchanged.
- **On re-entry:** the textarea is always blank. Re-entering text appends a new entry rather than editing the previous one. This keeps the implementation simple and avoids the complexity of mapping a flat string back to a specific array position.

---

### Step 4 — Review & confirm

A summary card showing all selections as plain English:

- Assistant name and title
- Tone: "Your tone is warm and direct."
- Detail: "You prefer concise responses."
- Directness: "Positions are stated directly."
- Posture: "The assistant will verify before taking external actions."
- Freeform preferences (if any): shown as a blockquote

Two actions: **← Back** / **Confirm & save**

On "Confirm & save":
1. Button shows a loading state ("Saving…", disabled)
2. `PUT /api/identity` with the compiled identity config
3. `POST /api/identity/reload`
4. Dismiss overlay → navigate to Chat → show success banner
5. On API error: show inline error message, re-enable the button

---

## Step Navigation

- **Next** validates the current step before advancing (name field non-empty on Step 1; at least 1 tone word on Step 2)
- **Back** never validates — always permitted
- State is preserved across Back/Next traversals within a session
- Step progress dots in the top bar reflect completed steps

---

## Implementation Scope

### Files changed

| File | Change |
|------|--------|
| `src/channels/http/routes/kg.ts` | Main changes — see below |
| `src/channels/http/routes/identity.ts` | Add `configured` flag to `GET /api/identity` response |

### `kg.ts` changes

1. **`createUiHtml()` — CSS additions:**
   - Wizard overlay styles (full-screen fixed layer, scroll container)
   - Tone pill active/disabled states
   - Slider preview blockquote style
   - Decision posture card selected state
   - Settings nav section (mirrors Memory section styles — no new CSS classes needed)
   - Success banner style

2. **`createUiHtml()` — HTML additions:**
   - Wizard overlay div (`id="view-wizard"`, `position: fixed; inset: 0; z-index: 60; display: none`)
   - Settings nav section with Setup Wizard sub-item (after the Memory section)
   - Success banner div (`id="chat-success-banner"`, hidden by default, shown post-wizard)

3. **`createUiHtml()` — JS additions:**
   - `wizardState` object holding form values across steps
   - `showWizard()` / `hideWizard()` — show/hide the overlay, populate fields from current identity on re-entry
   - `navigateWizardStep(n)` — show the correct step, update progress dots
   - Tone pill click handler — enforces 1–3 selection, updates live preview sentence
   - Slider input handlers — update live preview sample sentences
   - Decision posture click handler
   - `validateWizardStep(n)` — returns true/false for Next button
   - `submitWizard()` — compiles state into identity payload, calls PUT then reload, handles loading/error states
   - Update `showMain()` to check `configured` flag and call `showWizard()` if false
   - Update `navigate()` to handle `'wizard'` case
   - Change default landing view from `'kg'` to `'chat'`

4. **`knowledgeGraphRoutes` — update `GET /` route:** After auth check passes, `showMain()` now also fetches `GET /api/identity` to determine first-run state. This fetch uses the session cookie (no extra auth header needed).

### `identity.ts` changes

`GET /api/identity` handler: add a second query to check for any `wizard` or `api` versions before returning.

### Auth refactor — shared sessions store

**Problem:** The wizard JS runs in the browser with only the session cookie set by `POST /auth`. The identity routes currently only accept the `x-web-bootstrap-secret` header (they do not check the session cookie). The KG routes work because their internal `assertSecret()` checks both. The wizard cannot call `GET /api/identity` or `PUT /api/identity` from the browser as-is.

**Fix:** Lift the `sessions` Map (currently scoped inside `knowledgeGraphRoutes`) up to the `HttpAdapter` level. Pass it as an option to both `knowledgeGraphRoutes` and `identityRoutes`. Update `identityRoutes` to accept either:
- A valid `x-web-bootstrap-secret` header, OR
- A valid `curia_session` cookie (verified against the shared sessions store)

This mirrors the existing `assertSecret()` logic in `kg.ts` and requires no new security mechanism — it reuses the same token store.

Files additionally affected: `src/channels/http/http-adapter.ts` (sessions Map construction + passing), `src/channels/http/routes/identity.ts` (updated auth helper).

---

## Non-Goals

- The `constraints` field is not editable in the wizard (noted in `identity.ts` with a `@TODO` — deferred)
- `decision_style.internal_analysis` is not surfaced (stays at YAML default)
- Channel or contact tone overlays (deferred per spec 13)
- Multi-step wizard progress persistence across page refreshes (in-memory state only — if the user refreshes mid-wizard on first run, they start over)
