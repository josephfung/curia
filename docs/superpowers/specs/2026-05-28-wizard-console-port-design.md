# Design: Port Wizard View to Console App (Issue #751)

**Date:** 2026-05-28
**Branch:** feat/wizard-console
**Issue:** josephfung/curia#751

## Overview

Port the existing onboarding wizard from the legacy KG web app (where it lives as embedded HTML/JS in `kg.ts`) to the new React console app (`apps/console/`). This is the first view migration — a pilot for the porting pattern.

The wizard collects four things: assistant identity, communication tone, decision posture, and optional behavioral preferences. It is the first experience a new user has after logging in.

---

## 1. Routing & Architecture

### New route: `/setup`

- Added to `apps/console/src/router.tsx` as a **top-level route**, not nested under the `DashboardPage` layout (which has sidebar + topbar).
- Renders `WizardPage` directly — no sidebar, no topbar.

### First-run redirect

- The existing auth guard calls `checkSession()` which hits `GET /api/identity`. That response includes a `configured: boolean` flag.
- Extend the guard: if `configured === false`, redirect to `/setup` before allowing through to `/`.
- If a user navigates to `/setup` directly when already configured, allow it (no forced redirect away — the wizard can serve as a manual re-run tool even without a settings link).

### Post-completion navigation

- After submit succeeds: navigate to `/` (dashboard).

### Step URL persistence

- `?step=1` through `?step=4`, driven by TanStack Router search params.
- "Back" decrements step, "Continue" (with validation) increments.
- On refresh, the user lands on the correct step with an empty form (step-only persistence, no field values in URL).

---

## 2. Component Structure

Single file: `apps/console/src/pages/WizardPage.tsx`

The wizard is a self-contained full-screen page:
- **Header bar**: Curia wordmark (left) + step counter and progress dots (right): `Step N of 4  ●●○○`
- **Content column**: 520px max-width, centered, scrollable
- **Step body**: rendered conditionally from `currentStep`
- **Footer buttons**: Back / Continue (or "Confirm & save" on step 4)

No sub-components for individual steps — all four steps live inline in the same file.

---

## 3. Data Model

```ts
type WizardState = {
  name: string;           // default: "Alex Curia"
  title: string;          // default: "Executive Assistant to the CEO"
  signature: string;      // default: ""
  toneBaseline: string[]; // default: ['warm', 'direct'], min 1 selected, max 3 selected
  verbosity: number;      // default: 50, range 0–100
  directness: number;     // default: 75, range 0–100
  posture: 'conservative' | 'balanced' | 'proactive'; // default: 'conservative'
  preferences: string;    // default: ""
};
```

Managed with a single `useState<WizardState>` in `WizardPage`.

### On mount

- `GET /api/identity` — pre-populate all fields from current identity (handles both first-run with YAML defaults and re-entry with existing saved values).
- Show a loading spinner in the content area while fetching; the header/progress bar renders immediately.

### On submit (step 4 "Confirm & save")

1. `PUT /api/identity` with the compiled identity payload + `note: 'Saved via onboarding wizard'`
2. `POST /api/identity/reload`
3. Navigate to `/`

### Error handling

- Submit failure: inline error message below the Confirm button, wizard stays on step 4, button re-enabled.

---

## 4. Step Content

### Step 1 — Identity

Fields:
- `name`: text input, required, placeholder "Alex Curia"
- `title`: text input, placeholder "Executive Assistant to the CEO"
- `signature`: textarea, optional (labeled "Optional")

Validation before Continue: `name` must not be empty.

### Step 2 — Tone

Fields:
- `toneBaseline`: pill grid from `BASELINE_TONE_OPTIONS` (hard-coded array in `WizardPage.tsx`; source word list is in `src/channels/http/routes/kg.ts` — search for `BASELINE_TONE_OPTIONS`). Selection rules: min 1, max 3. Unselected pills dim when 3 are chosen. Live preview sentence updates on each selection.
- `verbosity`: range slider 0–100. Live preview sentence below the slider.
- `directness`: range slider 0–100. Live preview sentence below the slider.

### Step 3 — Posture

Fields:
- `posture`: three pill buttons (Conservative / Balanced / Proactive), single-select, one always active.
- `preferences`: textarea, always blank on entry (append mode — this input is appended to the existing `behavioralPreferences` array, not used to overwrite it).

### Step 4 — Review

- Summary card showing all selections as plain English: name, title, tone phrase, verbosity/directness description, posture, preferences snippet (if any entered).
- Buttons: ← Back / Confirm & save
- Loading state on Confirm: spinner, button disabled while in-flight.

---

## 5. Old KG App Cleanup (`src/channels/http/routes/kg.ts`)

Remove the following from the monolithic KG HTML generator:

- `wizardState` object
- `showWizard(identity)` function
- `hideWizard()` function
- `navigateWizardStep(n)` function
- The first-run check inside `showMain()` that calls `showWizard()`
- All wizard HTML: `#wizard-overlay`, `#wstep-1` through `#wstep-4` divs
- All wizard CSS (scoped to wizard overlay/steps)

The backend identity API endpoints (`GET/PUT /api/identity`, `POST /api/identity/reload`) are shared and must not be removed — they are used by the new console wizard.

---

## 6. Testing

- Unit tests for `WizardPage`: step navigation (step increments/decrements, URL param syncs), tone pill selection logic (min/max enforcement), form validation (step 1 name required).
- Integration test: full wizard submission flow — mock `PUT /api/identity` and `POST /api/identity/reload`, assert navigate to `/` on success.
- Existing backend identity route tests are unaffected.

---

## 7. Out of Scope

- Settings link to re-run the wizard (to be added with a future settings form migration)
- Backend-driven tone options (hard-coded `BASELINE_TONE_OPTIONS` for now; `@TODO` comment to revisit)
- Any redesign of wizard content or copy (straight port of existing UX)
