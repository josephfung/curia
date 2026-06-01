# 18 — Onboarding

**Date:** 2026-06-01
**Status:** Shipped (v0.32)

## Goal

Take a new contributor from `git clone` to a working, personalized Curia
instance in one path with no detours. The onboarding flow spans three layers
that were designed and shipped together as the v0.32 milestone:

1. **Host bootstrap** — a single `pnpm run setup` command brings up Postgres,
   applies migrations, and starts the stack.
2. **Form wizard** (`/setup`) — captures assistant identity, voice, and
   decision posture; writes them through the existing identity API.
3. **In-chat specialist** (`setup-wizard` agent) — runs automatically on the
   first chat message after the form wizard exits, interviews the principal
   about priorities and working hours, and guides any remaining integration
   setup.

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
| `node` | `node --version` ≥ 22 |
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
that captures the principal contact + the configurable parts of the office
identity over five steps.

### Routing

- `/setup` is its own route in `apps/console/src/router.tsx`, sibling to the
  dashboard rather than nested inside it — no sidebar, no topbar, full-screen.
  It is gated by the same auth guard as the dashboard.
- The auth guard checks `configured: boolean` from `GET /api/identity`. If
  `configured === false`, it redirects to `/setup` before letting the user
  through to `/`.
- After successful submit on step 5, the wizard navigates **directly to
  `/chat`** (not to `/`) so the kickoff message can fire immediately.
- `/setup` remains accessible directly even when configured — it can be
  used as a manual re-run tool until a Settings UI is built.
- Step state lives in the URL as `?step=1`..`?step=5` (TanStack Router
  search params, clamped 1–5). Field values do not persist across reloads.

### Step content

| Step | Captures | Validation |
|------|----------|------------|
| 1 — About you | `principalName` (the CEO's name) — written through `POST /api/setup/principal` (idempotent) before advancing | non-empty |
| 2 — Identity | `name`, `title`, `signature` (optional) | `name` required |
| 3 — Tone | `toneBaseline` (1–3 pills from `TONE_OPTIONS`), `verbosity` slider 0–100, `directness` slider 0–100 | 1 ≤ pills ≤ 3 |
| 4 — Posture | `posture` (Conservative / Balanced / Proactive), `preferences` textarea (appended to existing `behavioralPreferences`, not replaced) | none |
| 5 — Review | Summary card, Confirm & save button | none |

**Step 1 auto-skip.** When a principal contact already exists at mount time
(e.g. deployments that seeded one via `CEO_PRIMARY_EMAIL`), the wizard
detects this from `GET /api/setup/status` and silently advances past step 1
to step 2. "Back" from step 2 is a no-op in this case rather than flickering
through the auto-skip again.

**Tone options.** The 1–3 baseline pills come from `TONE_OPTIONS` in
[apps/console/src/pages/wizard-utils.ts](../../apps/console/src/pages/wizard-utils.ts).
The server-side counterpart is `BASELINE_TONE_OPTIONS` in
`src/identity/types.ts`. Reconciling these two sources into one is tracked
as a follow-up.

### API integration

- **On mount:** `GET /api/identity` populates the form with current values
  (the defaults seeded from `src/identity/defaults.ts` on first boot, or the
  last saved values on re-entry); `GET /api/setup/status` resolves
  `principalExists` for the auto-skip decision.
- **On step 1 advance:** `POST /api/setup/principal` with `{ name }` writes
  the principal contact before the user moves to step 2.
- **On submit (step 5):**
  1. `PUT /api/identity` with the compiled identity payload and
     `note: 'Saved via onboarding wizard'`.
  2. `POST /api/identity/reload` to refresh the in-memory cache.
  3. `GET /api/setup/status` to read `externalAdaptersPending`.
  4. If `externalAdaptersPending === false` (email/Signal already running,
     or never gated): set
     `localStorage['curia:onboarding:welcome-banner-pending']` and
     `navigate({ to: '/chat' })`.
  5. Otherwise: `POST /api/setup/restart` to ask the supervisor to bring
     the process back up in normal mode (email/Signal channels online). The
     wizard then renders a full-screen "Setting up channels…" wait state and
     polls `GET /api/setup/status` for the new `bootStartedAt`. When it
     flips, the wizard sets the kickoff flag and navigates to `/chat`.
     A 409 from `/api/setup/restart` is treated as success-equivalent (a
     concurrent tab already restarted the process).

### Submit failure

Inline error message under the Confirm button. The wizard stays on step 5
with the button re-enabled. The PUT itself is a single atomic write to
`office_identity_versions`, so a failure mid-pipeline (e.g. between the
reload and the restart) is recoverable by re-submitting. The restart-wait
state has its own 60-second timeout; on timeout it falls into a
"Curia didn't come back yet" view with a Keep waiting retry button.

### Out of scope

- A Settings link to re-run the wizard (deferred until the settings page
  is migrated to the console).
- Backend-driven `BASELINE_TONE_OPTIONS` (still hard-coded; `@TODO`).
- Any redesign of wizard copy (the v0.32 work was a straight port from
  the legacy KG-app embedded HTML).

---

## Layer 3 — `setup-wizard` specialist agent

A delegated specialist that owns the conversational first-experience after
the form wizard exits, and that the coordinator can re-invoke for "help me
set up X" requests later.

### Delegation model

`setup-wizard` is a specialist — not a user-facing agent. The coordinator
remains the only voice. The specialist's output is paraphrased and relayed
by the coordinator, following the same pattern as `research-analyst`. No
new routing logic was added; the coordinator's `${available_specialists}`
injection picks it up automatically from
[agents/setup-wizard.yaml](../../agents/setup-wizard.yaml).

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

### Conversation flow

| Turn | Specialist output |
|------|-------------------|
| 1 | Warm greeting + "What takes up most of your time right now — email, scheduling, research, staying on top of news?" |
| 2 | Map answer to concrete next steps (email-heavy → Nylas env vars; research → web search already wired). Persist a preference via `behavioral-preferences-update` (append). Ask: "What are your usual working hours and timezone?" |
| 3 | Acknowledge hours. Ask: "Would a regular debrief be useful — daily summary, weekly digest?" |
| 4 | If yes: schedule via `scheduler-create`. Close with a brief summary. |

The coordinator personalizes the relay with the principal's name; the
specialist writes only what the coordinator should say.

### Re-invocation paths

| Trigger | Specialist behaviour |
|---------|----------------------|
| "Help me set up Nylas / Twilio / Signal / OpenAI" | Return env var names, restart note, "v2 in-app flow coming" caveat |
| "What can you do?" | Call `skill-registry`, return ~5 plain-language bullets grouped by category |
| "Just finished setup — say hi!" (kickoff text) | Run the 4-turn flow above |

### Skills pinned to setup-wizard

- `behavioral-preferences-update` (appends to `OfficeIdentity.behavioralPreferences`)
- `scheduler-create`, `scheduler-list`, `scheduler-cancel`
- `skill-registry`
- `memory-store`
- `executive-profile-update`

Pinning prevents reliance on dynamic discovery; `allow_discovery: false`
and `inject_specialists: false` keep the agent focused.

### `behavioral-preferences-update` skill

A new skill that mirrors `executive-profile-update`. Writes to
`OfficeIdentity.behavioralPreferences` via the `officeIdentityService`
capability (added to the execution layer for this milestone — mirrors the
existing `executiveProfileService` pattern).

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

### Out of scope (v2, tracked in #808)

- In-app Nylas OAuth flow and grant capture.
- Phone number provisioning (Twilio) walkthrough.
- Signal channel verification.
- OpenAI key collection and secure storage.
- Persistent step-state tracking across sessions.

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
       (auto-skipped if a principal already exists)
  steps 2–4 (Identity, Tone, Posture) — local state only
  step 5 (Review) submit:
       PUT /api/identity  →  POST /api/identity/reload
                          →  GET /api/setup/status
       if externalAdaptersPending: POST /api/setup/restart,
         render "Setting up channels…" wait state until back up
       localStorage['curia:onboarding:welcome-banner-pending'] = true
       navigate({ to: '/chat' })
/chat mounts
  ↓  useChatSession sees the localStorage flag, clears it,
  ↓  auto-sends "Just finished setup — say hi!"
coordinator delegates to setup-wizard               ← Layer 3
  ↓
greeting + first interview question appears as agent reply
```

---

## Implementation Status

| Item | Status |
|------|--------|
| `scripts/setup.sh` — prereq checks, secret generation, Postgres start, migrations, stack up | Done |
| `package.json` script `setup` → `bash scripts/setup.sh` | Done |
| `.env.example` — `DB_USER=curia`, commented `CEO_PRIMARY_EMAIL` placeholder | Done |
| README Quickstart — single-command `pnpm run setup` block | Done |
| `apps/console/src/pages/WizardPage.tsx` — 5-step React form (About you, Identity, Tone, Posture, Review) | Done |
| `apps/console/src/router.tsx` — `/setup` route sibling to the dashboard | Done |
| Auth guard — redirect to `/setup` when `configured === false` | Done |
| `POST /api/setup/principal`, `GET /api/setup/status`, `POST /api/setup/restart` — wizard backend | Done |
| Setup-required boot mode — process stays up without principal so the wizard is reachable | Done |
| Legacy KG-app wizard HTML/JS in `src/channels/http/routes/kg.ts` — removed | Done |
| `agents/setup-wizard.yaml` — specialist with pinned skills and inject_specialists off | Done |
| `skills/behavioral-preferences-update/` — manifest + handler + tests | Done |
| `officeIdentityService` capability — added to `SkillContext`, loader, execution, bootstrap | Done |
| Chat auto-kickoff — `useChatSession.ts` reads + clears localStorage flag, sends `KICKOFF_TEXT` | Done |
| `tests/integration/setup-wizard-delegate.test.ts` — kickoff delegates, normal greeting doesn't | Done |

---

## Related specs

- [02 — Agent System](02-agent-system.md) — coordinator delegation, specialist routing
- [03 — Skills & Execution](03-skills-and-execution.md) — `action_risk`, capability injection
- [13 — Office Identity](13-office-identity.md) — `OfficeIdentity` schema, `OfficeIdentityService`, HTTP API
- [14 — Autonomy Engine](14-autonomy-engine.md) — `action_risk` enforcement
