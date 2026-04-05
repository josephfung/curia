# feat: Onboarding Wizard (web app)

## Summary

Add a multi-step onboarding wizard to the Curia web app that guides a new user through configuring their office identity on first run. The wizard can also be re-entered from a settings page to update the identity at any time.

This feature depends on the Office Identity Engine (see companion issue). It assumes `GET /api/identity` and `PUT /api/identity` are available.

## User Flow

### Entry points

1. **First run** — if `GET /api/identity` returns no configured identity (or returns the default placeholder), the web app redirects to the wizard automatically on load
2. **Settings** — a "Reconfigure assistant" action in the web app settings re-enters the wizard with current values pre-filled

### Step 1 — Name your assistant

> "What should your assistant be called?"

- Text input: **Assistant name** (e.g., "Alex")
- Text input: **Title** (e.g., "Executive Assistant to the CEO", pre-filled default)
- Text area: **Email signature** (pre-filled with `{name}\nOffice of the CEO`)

### Step 2 — Communication style

> "How should your assistant communicate?"

**Tone** — multi-select pill grid, pick 1–3 (maps to `tone.baseline: string[]`)

Display all ~30 options from `BASELINE_TONE_OPTIONS` as a grid of pills. Grouped visually by category but no category headers needed — the grouping is just for visual scanning:

> warm · friendly · approachable · personable · empathetic · encouraging · gracious · caring
> direct · blunt · candid · frank · matter-of-fact · no-nonsense
> energetic · calm · composed · enthusiastic · steady · measured
> playful · witty · dry · charming · diplomatic · tactful · thoughtful · curious
> confident · assured · polished · authoritative · professional

- Minimum 1 pick, maximum 3 — disable further selection at 3 with a hint: "Pick up to 3"
- Default selection: `["warm", "direct"]`
- Preview sentence updates as picks change: "Your tone is warm and direct."

**Detail level** — labeled slider, 0–100 (maps to `tone.verbosity`)
- Left anchor label: "Brief" — short responses by default
- Right anchor label: "Thorough" — detailed responses by default
- Default: 50
- Show a short sample sentence that updates as the slider moves so the user can feel the difference

**Directness** — labeled slider, 0–100 (maps to `tone.directness`)
- Left anchor label: "Measured" — acknowledges uncertainty, appropriate qualification
- Right anchor label: "Direct" — states positions plainly, minimal hedging
- Default: 75
- Show a short sample sentence that updates as the slider moves

**Decision posture (external actions)** — pill selector (maps to `decision_style.external_actions` enum)
- `Conservative` _(default)_ — verify before acting; flag ambiguity
- `Balanced` — act when confident, flag when uncertain
- `Proactive` — bias toward action; less checking in

### Step 3 — Anything else?

> "Is there anything else we should know about how you like things handled?"

- Text area, optional, freeform
- Helper text: "E.g., 'Always include agenda items in meeting requests' or 'Flag emails from investors as high priority'"
- Input is stored as additional `behavioral_preferences` entries

### Review & confirm

Summary card showing all selections before submission:
- Assistant name and title
- Selected tone/detail/posture as plain English sentences (not the enum values)
- Any freeform preferences

Two actions: **Back** / **Confirm & save**

On confirm:
1. `PUT /api/identity` with the compiled config
2. `POST /api/identity/reload` to apply immediately
3. Redirect to main web app view with a success banner: "Your assistant is ready."

## Acceptance Criteria

- [ ] On first load with no configured identity, the app redirects to the wizard
- [ ] Step navigation works (next/back) with selections preserved across steps
- [ ] Tone pill grid enforces 1–3 selections and disables further picks at 3
- [ ] Selected tone words map correctly to `tone.baseline` string array
- [ ] Verbosity slider value (0–100) maps correctly to `tone.verbosity`
- [ ] Directness slider value (0–100) maps correctly to `tone.directness`
- [ ] Decision posture pill maps correctly to `decision_style.external_actions` enum value
- [ ] Sample sentences update live as sliders move
- [ ] Freeform text in step 3 is appended to `behavioral_preferences` (not overwriting defaults)
- [ ] Review screen shows human-readable summaries, not raw config values
- [ ] Submitting calls `PUT /api/identity` then `POST /api/identity/reload`
- [ ] Success redirects to the main app with a confirmation banner
- [ ] Re-entering the wizard pre-fills all fields with current identity values
- [ ] A "Reconfigure assistant" entry point is accessible from web app settings

## Design Notes

- Use pill/button selectors for step 2, not dropdowns — the three choices per dimension should be immediately scannable, not hidden behind a click
- The wizard should feel like a 2-minute task, not a settings form — no more than 3 steps plus the review screen
- Sample sentences for the sliders are required (see step 2 above), not optional — they're the primary way the user calibrates the scalar values without needing to reason about numbers

## Dependencies

- Office Identity Engine issue (must ship first or in the same PR)
- `GET /api/identity` — detect first-run state
- `PUT /api/identity` — save wizard output
- `POST /api/identity/reload` — apply immediately after save

## Spec

`docs/specs/13-office-identity.md`
