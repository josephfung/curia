# 18 — Onboarding

**Date:** 2026-06-01
**Status:** Shipped (v0.32; Layer 2 expanded in v0.37; Layer 3 rewritten in v0.37)

## Goal

Take a new contributor from `git clone` to a working, personalized Curia
instance in one path with no detours. The onboarding flow spans three layers:

1. **Host bootstrap** — a single `pnpm run setup` command brings up Postgres,
   applies migrations, and starts the stack.
2. **Form wizard** (`/setup`) — captures the principal's identity and operational
   profile, plus the assistant's identity, tone & style, and autonomy level.
3. **In-chat specialist** (`setup-wizard` agent) — an outcome-backward concierge
   that runs on first chat and whenever the principal asks for help setting up
   integrations; catalog-aware and deferral-aware.

The three layers are independent (each can be re-entered or skipped), but
when run in sequence they constitute the end-to-end first-run experience.

---

## Layer 1 — Host bootstrap (`pnpm run setup`)

A bash script (`scripts/setup.sh`) wired up as a package.json script. Fully
idempotent.

### Prerequisite checks

Fails fast with a one-line message and install link if any are missing:

| Tool | Check |
|------|-------|
| `docker` | `docker info` exits 0 |
| `docker compose` | `docker compose version` exits 0 |
| `node` | `node --version` ≥ 24 |
| `pnpm` | `pnpm --version` exits 0 |
| `openssl` | `command -v openssl` (used for CSPRNG secret generation) |

### First-run path

1. Generate `DB_PASSWORD`, `API_TOKEN`, `WEB_APP_BOOTSTRAP_SECRET` using
   `openssl rand -hex 32`.
2. Prompt for an Anthropic API key (validated against `sk-ant-[A-Za-z0-9_-]+`,
   3 retries).
3. Write `.env` from `.env.example`, substituting generated and collected values.
   Optional channel vars (Nylas, OpenAI, Signal, Tavily) stay commented.
4. `docker compose up -d postgres`, poll health every 2s up to 60s.
5. Install npm dependencies (`pnpm install --frozen-lockfile`) when
   `node_modules/` is absent.
6. `pnpm run migrate` against the running Postgres.
7. `docker compose up -d` to start the full stack.
8. Poll Curia's healthcheck until it reports ready, so the success banner
   reflects an actually-working install rather than just "the container
   started."
9. Append `# SETUP_COMPLETE` to `.env` as a clean-finish marker.
10. Print a summary box with `http://localhost:3000` and the bootstrap secret.

### Re-entry path

If `.env` already exists, the script presents a three-option menu:

| Option | Effect |
|--------|--------|
| 1 — Start the stack | `docker compose up -d` and exit |
| 2 — Resume setup | Skip secret generation, jump to Postgres start |
| 3 — Full reset | Regenerate secrets (invalidates active sessions) after confirmation |

Option 2 is recommended (and highlighted in the menu) when `# SETUP_COMPLETE`
is absent — that signals a previous run was interrupted partway.

### Error handling

| Failure point | Behaviour |
|---------------|-----------|
| Missing prerequisite | Exit 1 with install link; no side effects |
| Bad Anthropic key | Retry up to 3 times; exit with console URL hint |
| Postgres health timeout | Exit 1 with `docker compose logs postgres` hint |
| Migration failure | Exit 1 with "run `pnpm setup`, choose option 2" hint |

### Out of scope for the script

- In-app onboarding (covered by Layers 2 and 3).
- Windows-native support (WSL works).

---

## Layer 2 — Form wizard at `/setup`

A React route in the console app (`apps/console/src/pages/WizardPage.tsx`)
that captures the principal contact and operational profile, plus the
configurable parts of the office identity, over six steps.

### Routing

- `/setup` is its own route in `apps/console/src/router.tsx`, sibling to the
  dashboard rather than nested inside it — no sidebar, no topbar, full-screen.
  It is gated by the same auth guard as the dashboard.
- The auth guard checks `configured: boolean` from `GET /api/identity`. If
  `configured === false`, it redirects to `/setup` before letting the user
  through to `/`.
- After successful submit on step 6, the wizard navigates **directly to
  `/chat`** (not to `/`) so the kickoff message can fire immediately.
- `/setup` remains accessible directly even when configured — it can be
  used as a manual re-run tool.
- Step state lives in the URL as `?step=1`..`?step=6` (TanStack Router
  search params, clamped 1–6). Field values do not persist across reloads.

### Step content

| Step | Captures | Validation |
|------|----------|------------|
| 1 — About you | `principalName` (the CEO's name) — written through `POST /api/setup/principal` (idempotent) before advancing. Pre-populates the current name on re-entry so it can be corrected; no longer auto-skips when a principal already exists. | non-empty |
| 2 — Your details | Principal operational profile: `timezone` (required, IANA string), `preferredName`, `title`, `primaryEmail`, `workingHours` (all optional). Written through `POST /api/setup/principal/profile`; email is stored as a verified `contact_channel_identity` that comes online after the wizard's restart. | timezone required |
| 3 — Identity | `name`, `title`, `signature` (optional). The assistant name and email signature are prefilled via `POST /api/setup/suggest-name` (LLM-suggested first name, silent static fallback on failure). | `name` required |
| 4 — Tone & style | `toneStyle` (a textarea, ≤800 chars, started from one of four starter templates that each end in an example line), `verbosity` (the Detail slider, 0–100) | style non-empty, ≤800 chars |
| 5 — Autonomy & preferences | `autonomyBand` (one card per autonomy band, pre-selected from the current score), `preferences` textarea (appended to existing `behavioralPreferences`, not replaced) | none |
| 6 — Review | Summary card, Confirm & save button | none |

**Standing preferences storage (#1376):** they live on `OfficeIdentity`
(`behavioralPreferences`), versioned with the rest of office identity via
`PUT /api/identity`, and are **not** part of `ExecutiveProfile`. Post-setup editing is
on Settings → Standing preferences (`/settings/posture`; it replaces the list, the
wizard still appends).

**Autonomy, not posture (#2143).** Step 5 used to ask for a decision posture
(Conservative / Balanced / Proactive) stored as `decisionStyle`, which no gate read and
which could contradict the autonomy score. It now asks for the autonomy band, the setting
that actually decides act-vs-ask (spec 14):
- **Bands and copy** come from `apps/console/src/autonomy-bands.ts`, shared with
  Settings → Autonomy. A picked band saves as its lower bound (`scoreForBand`), so it never
  unlocks an `action_risk` tier above what its name says.
- **`GET /api/autonomy` is a required load,** like `/api/identity` and `/api/setup/status`.
  If it fails, or returns no config, the wizard shows a load error rather than guessing
  a band: submitting a guessed default could quietly lower a real score.

**Tone & style templates.** The four starters (*Dry & understated*, *Warm & personable*,
*Crisp & direct*, *Formal*) are `STYLE_TEMPLATES` in
[apps/console/src/pages/wizard-utils.ts](../../apps/console/src/pages/wizard-utils.ts).
Choosing one replaces the text without asking only when the text is empty or still a
template; otherwise the operator confirms first. The seeded default style is the *Warm &
personable* template, so a fresh install switches freely.

### API integration

- **On mount:** `GET /api/identity` populates the form with current values
  (the defaults seeded from `src/identity/defaults.ts` on first boot, or the
  last saved values on re-entry); `GET /api/setup/status` resolves
  `principalExists` to pre-populate step 1; `GET /api/autonomy` pre-selects step 5's
  band. All three are required.
- **On step 1 advance:** `POST /api/setup/principal` with `{ name }` writes
  the principal contact before the user moves to step 2.
- **On step 2 advance:** `POST /api/setup/principal/profile` with the
  operational profile fields writes timezone, preferred name, title, email,
  and working hours to the principal contact row.
- **On step 3 mount:** `POST /api/setup/suggest-name` fires to pre-fill the
  assistant name and signature (silent fallback on failure — also serves as
  an early Anthropic key smoke test).
- **On submit (step 6):**
  1. `PUT /api/autonomy` with the picked band's score and
     `reason: 'Set via onboarding wizard'`, skipped when the band is unchanged. It goes
     **first**: as soon as the wizard's identity save lands (recorded as an `api` version,
     since the wizard sends no `changedBy`), `isIdentityConfigured()` is true and the
     wizard never shows again, so an autonomy failure after the identity save could not be
     fixed here. With autonomy first, a failure leaves the deployment
     unconfigured and the wizard runs again.
  2. `PUT /api/identity` with the compiled identity payload and
     `note: 'Saved via onboarding wizard'`.
  3. `POST /api/identity/reload` to refresh the in-memory cache.
  4. `GET /api/setup/status` to read `externalAdaptersPending`.
  5. If `externalAdaptersPending === false` (email/Signal already running,
     or never gated): set
     `localStorage['curia:onboarding:welcome-banner-pending']` and
     `navigate({ to: '/chat' })`.
  6. Otherwise: `POST /api/setup/restart` to ask the supervisor to bring
     the process back up in normal mode (email/Signal channels online). The
     wizard then renders a full-screen "Setting up channels…" wait state and
     polls `GET /api/setup/status` for the new `bootStartedAt`. When it
     flips, the wizard sets the kickoff flag and navigates to `/chat`.
     A 409 from `/api/setup/restart` is treated as success-equivalent (a
     concurrent tab already restarted the process).

### Submit failure

Inline error message under the Confirm button, naming the call that failed ("Saving the
autonomy level failed: …"). The wizard stays on step 6 with the button re-enabled, and
does not reload, restart or navigate. The PUT itself is a single atomic write to
`office_identity_versions`, so a failure mid-pipeline (e.g. between the
reload and the restart) is recoverable by re-submitting. The restart-wait
state has its own 60-second timeout; on timeout it falls into a
"Curia didn't come back yet" view with a Keep waiting retry button.

### Out of scope

- A Settings link to re-run the wizard (deferred until the settings page
  is migrated to the console).
- Aligning the system timezone (cron scheduler, `TIMEZONE` env var) to the
  wizard-captured principal timezone — tracked as a follow-up.

---

## Layer 3 — `setup-wizard` specialist agent (v0.2.0)

A delegated specialist that owns the conversational first-experience after
the form wizard exits, and that the coordinator re-invokes for any "help me
set up X" request thereafter.

### Delegation model

`setup-wizard` is a specialist — not a user-facing agent. The coordinator
remains the only voice. The specialist's output is paraphrased and relayed
by the coordinator, following the same pattern as `research-analyst`. The
coordinator's `${available_specialists}` injection picks it up automatically
from [agents/setup-wizard.yaml](../../agents/setup-wizard.yaml).

The "first conversation" signal is the kickoff message text
(`"Just finished setup — say hi!"`) arriving in the task brief — not a
stored flag. The agent itself has no per-conversation state.

### Chat auto-kickoff

The chat page (`apps/console/src/pages/chat/useChatSession.ts`) reads
`localStorage['curia:onboarding:welcome-banner-pending']` on first mount.
If set, it auto-sends the kickoff text and clears the flag.

The flag is cleared **synchronously in the `useRef` initializer**, not in
the effect — this prevents React strict mode's double-mount from firing a
second kickoff in development. The effect itself runs once with empty deps.

### Conversation approach (v0.2.0 — outcome-backward concierge)

The v0.2.0 prompt replaces the fixed 4-turn interview script with an
**outcome-backward concierge** approach:

1. **Instant wins first.** The agent identifies tasks that are already
   done (via `setup-status`) and acknowledges them. No re-explaining.
2. **Outcome question.** "What do you most want Curia to do for you?" —
   the answer maps to the shortest path to a working integration.
3. **Shortest path.** Routes based on what the principal needs: email/Signal
   setup → console Channels page; lone API keys → in-chat secret capture.
4. **Defer the rest.** Remaining tasks are surfaced as optional follow-ups
   and can be deferred with `setup-defer` (`setup_wizard/deferrals` in
   config-store).

The catalog of setup tasks (`skills/setup/tools/setup-status/catalog.yaml`) is owned
by the skill bundle. The agent can show the full menu on request and can
resume deferred tasks in any subsequent session.

### Skills pinned to setup-wizard

- `setup-status` — read-only; returns the catalog with each task's live status
- `setup-defer` — write; persists or clears deferrals for catalog tasks
- `behavioral-preferences-update` (appends to `OfficeIdentity.behavioralPreferences`)
- `scheduler-create`, `scheduler-list`, `scheduler-cancel`
- `tool-registry`
- `memory-store`
- `executive-profile-update`

Pinning prevents reliance on dynamic discovery; `allow_discovery: false`
and `inject_specialists: false` keep the agent focused.

### `behavioral-preferences-update` skill

Writes to `OfficeIdentity.behavioralPreferences` via the
`officeIdentityService` capability.

| Property | Value |
|----------|-------|
| `operation` | `'append'` (default, idempotent — deduplicates by exact string match) or `'replace'` (overwrites the full list) |
| `entries` | non-empty `string[]` |
| `action_risk` | `low` (internal state write; min autonomy score 60) |
| `sensitivity` | `elevated` |

Persistence calls `OfficeIdentityService.update(...)` with `'skill'` as the
`changedBy` value, producing an `office_identity_versions` row per change.
See [13 — Office Identity](13-office-identity.md#officeidentityservice) for
the underlying service contract.

### Out of scope

- In-app Nylas OAuth flow and grant capture.
- In-app Telnyx OAuth / automated DID purchase (SMS uses Mission Control + vault; see ADR-036 / setup catalog).
- Signal channel verification.

---

## End-to-end flow

```
git clone … && cd curia
pnpm run setup                                    ← Layer 1
  ↓  generates .env, starts stack, prints bootstrap secret
open http://localhost:3000
  ↓  log in with bootstrap secret
auth guard sees configured === false
  ↓  redirects to /setup
[ form wizard ]                                   ← Layer 2
  step 1 (About you) → POST /api/setup/principal
  step 2 (Your details) → POST /api/setup/principal/profile
  step 3 (Identity) — LLM suggest-name prefill, local state
  steps 4–5 (Tone & style, Autonomy & preferences) — local state only
  step 6 (Review) submit:
       PUT /api/autonomy (if the band changed)
                          →  PUT /api/identity  →  POST /api/identity/reload
                          →  GET /api/setup/status
       if externalAdaptersPending: POST /api/setup/restart,
         render "Setting up channels…" wait state until back up
       localStorage['curia:onboarding:welcome-banner-pending'] = true
       navigate({ to: '/chat' })
/chat mounts
  ↓  useChatSession sees the localStorage flag, clears it,
  ↓  auto-sends "Just finished setup — say hi!"
coordinator delegates to setup-wizard               ← Layer 3 (v0.2.0)
  ↓
outcome-backward concierge: instant wins → outcome question
→ shortest path to first integration → defer the rest
```

---

## Related specs

- [02 — Agent System](02-agent-system.md) — coordinator delegation, specialist routing
- [03 — Skills & Execution](03-tools-and-execution.md) — `action_risk`, capability injection
- [13 — Office Identity](13-office-identity.md) — `OfficeIdentity` schema, `OfficeIdentityService`, HTTP API
- [14 — Autonomy Engine](14-autonomy-engine.md) — `action_risk` enforcement
