# 18 — Onboarding

**Date:** 2026-06-01
**Status:** Shipped (v0.32; Layer 2 expanded in v0.37; Layer 3 rewritten in v0.37)

## Goal

Take a new contributor from `git clone` to a working, personalized Curia
instance in one path with no detours. The onboarding flow spans three layers:

1. **Host bootstrap** — a single `pnpm run setup` command brings up Postgres,
   applies migrations, and starts the stack.
2. **Setup page** (`/setup`, #2358) — the operator's checklist: who Curia is for,
   Curia's name, its channels, Apply & restart, then Start onboarding.
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
   Optional channel vars (Nylas, OpenAI, Signal) and the optional Tavily key stay
   commented. Web search needs no key: it runs Tavily keyless, and a key only raises
   its limits (#2445).
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

## Layer 2 — The Setup page at `/setup` (#2358)

A React route in the console app (`apps/console/src/pages/setup/`) that replaced the
six-step form wizard. It is the console's landing page on a new install until Start
onboarding, and an install that predates it never sees it. Design and mockup:
`docs/wip/2026-10-29-onboarding-journey-design.md` (Phase 1) and
`docs/wip/2026-10-29-onboarding-journey-design/setup-page-mockup.html`.

### Routing

- `/setup` is its own full-screen route in `apps/console/src/router.tsx` (no sidebar or
  topbar), behind the same auth guard as the rest of the console. `?step=<id>` opens one
  step directly; without it the page opens on the first required step that isn't done.
- The first-load gate is `setupRedirect` (`pages/setup/setup-steps.ts`), fed by
  `GET /api/identity`'s `inSetup` (true from a new install's first load until Start
  onboarding; migration 130 marked older installs complete). While Setup runs, every page
  but the Setup page and the Settings pages its steps link to (`/settings`, `/system`,
  `/channels`, `/tools`, `/agents`, `/mcp-skills`, `/secrets`, `/contacts`) redirects to
  `/setup`; outside Setup, `/setup` redirects home. A server that predates `inSetup` falls
  back to the older `configured` flag.

### Steps

The step list shows each step's mark from the Setup checklist (`GET /api/setup/checklist`,
the same computation as the setup agent's `setup-status`): done, waiting for a restart,
not done, or locked. Status shows as one line inside the open step.

| Step | Saves | Through |
|------|-------|---------|
| Who it's for | Myself or someone else; for someone else, the operator's name and email; the principal's name, title, email, timezone and pronouns | `PUT /api/setup/state` (first, which starts Setup), `POST /api/setup/principal`, `POST /api/setup/principal/profile` |
| Curia's name | Name, title, email signature (a suggested first name on a new install, #799) | `PUT /api/identity` (`changedBy: 'wizard'`, the assistant block only) and `POST /api/identity/reload` |
| Email | The Nylas API key, then Curia's own mailbox (Connect with Google, or a pasted grant ID); the email channel is turned on once both are there | `PUT /api/vault/secrets/channel.email.nylas_api_key`, the email accounts routes, `POST /api/registry/channels/email/{install,enable}` |
| Messaging | The route (the Curia app, Signal, SMS or Slack), that route's credentials, and the principal's id on it (Signal number, mobile, Slack member id), linked to their contact. Nothing is sent to the principal | `PUT /api/setup/state`, the vault, the channel routes, `POST /api/contacts/:id/identities` |
| Voice | The route (the app or a Signal call; Phone shows as coming soon), the Deepgram and Cartesia keys and Curia's voice. LiveKit's keys come with the install (#2689). A Signal call also takes Signal's credentials and the principal's number when messaging isn't Signal | `PUT /api/setup/state`, the vault, the channel routes |
| Email & calendar | The Nylas API key again (the same key, so the step stands alone), the Nylas sign-in checks, and Connect with Google for the principal | the vault, `/api/registry/nylas/*` |
| Apply & restart | One restart turns on everything saved; every step is checked again | `POST /api/system/restart`, then `GET /api/system` until `bootedAt` changes |
| Start onboarding | Locked until `setupComplete`, listing what's left. Ends Setup and loads the console afresh, so no chat stream stays on the Setup thread | `POST /api/setup/complete` (rotates the web thread) |

Every field a step needs is on the step, so an operator never has to leave Setup. A channel
is turned on as soon as its required credentials resolve; it starts at Apply & restart.

### Optional extras

Listed under "Optional extras" after Start onboarding, unnumbered ("Optional extra" in the
eyebrow), and never counted toward the required steps or `setupComplete`. Save and continue
walks them in order; the last returns to Start onboarding. An extra is ticked only once
something is set up: Google Workspace when its three keys are saved, the search limit when
the Tavily key is (`optional_upgrade.configured`). Working style is never ticked, since its
check is always done.

| Extra | Saves | Through |
|-------|-------|---------|
| Working style | A tone (one of the four tone templates) and an independence level: Draft only, Ask first (the default) or Spot-check, at scores 65, 75 and 85. Each saves when picked. They are a starting point: the principal is offered them in the first conversation and can change them | `PUT /api/identity` (`tone.style` only, `changedBy: 'working_style'`, which doesn't tick Curia's name); `PUT /api/autonomy` |
| Google Workspace | Curia's Google address and the OAuth client ID and secret. "Sign in as Curia" shows as coming soon (#2683) | `PUT /api/vault/secrets/{curia_google_email,google_oauth_client_id,google_oauth_client_secret}` |
| Higher search limit | The Tavily key, with links to tavily.com and the curia-docs limits page | `PUT /api/vault/secrets/tavily_api_key` |
| Capabilities | Switches over the registry (below). Meetings always on; Email triage off and locked ("<principal> turns this on during onboarding") | `POST /api/registry/:kind/:name/{install-enable,disable}` |

### Capabilities

One list of switches, used as the last optional extra and as **Settings → Behaviour →
Capabilities** (`apps/console/src/pages/capabilities/`). Each capability is a group of
registry entries switched together, from a small catalog (`capabilities.ts`): label,
description, the agents, skill bundles and standalone tools it covers, and an optional lock.

| Capability | Covers | Lock |
|---|---|---|
| Meetings | `meetings` bundle, `meeting-notes-start`, `meeting-agenda-load` | Always on |
| Meeting debriefs | `meeting-debrief` agent | |
| Web research | `research-analyst` agent, `web` bundle | |
| Projects and tasks | `tasks` bundle | |
| Diagnostics | `diagnostics` agent and bundle (opt-in on a new install, #1356) | |
| Email triage | `ceo-inbox` agent, `ceo-inbox` and `learning` bundles | Off in Setup: the principal turns it on during onboarding |

- A switch shows on, off, "Partly on" (some entries on: switching sets them all), or "Not
  available on this install" (an entry missing or with a broken manifest).
- Turning on enables what the capability pins before its agents; turning off disables the
  agents first. Calls run one at a time through the existing `/api/registry` routes; a
  failure stops there and says whether part of it changed.
- Before turning off, enabled agents outside the capability that pin one of its bundles (or
  a bundle tool directly) are named, and the operator confirms. Web research and Projects
  and tasks always warn: the coordinator pins `web` and `tasks`.
- Registry changes apply at the next restart: in Setup, at Apply & restart.

### The setup guide panel

The setup agent as a help panel; it never drives Setup.

- **Layout.** A full-height column docked to the right edge (`SetupGuidePanel`), on the page
  background past one thin line; the page makes room for it. Below 1,180px wide the step list
  hides while it is open, and its Steps button closes it; on a phone it is full-screen.
- **When it opens.** By itself on a first run (`isFirstRun`: nothing saved yet), except on a
  phone; closed when an operator comes back. Each step's "Need help? Ask the setup guide"
  opens it with "I'm on the <step> step." in the composer, focused and unsent. The link is
  hidden while the panel is open.
- **No new chat endpoints or components.** It renders `ChatThread`, `ChatComposer` and
  `useChatSession` over `/api/chat/*`. `useChatSession({ setupStep })` sends the open step as
  `setupStep` on `POST /api/chat/messages`; the server keeps it only while Setup runs and the
  setup agent reads it as a `[Setup page: ...]` line. `ChatComposer` takes a `draft`.
- **Step markers.** When the open step changes, a "Now on: <step>" line appears in the
  thread. They live in the panel only, not in the saved history.
- **Setup starts when the page opens.** `POST /api/setup/start` creates the Setup row as
  in progress, so web chat reaches the setup guide from the first message, before anything
  is saved. It does so only on a database with nothing set up (no principal, no saved office
  identity: migration 130's test), and never reopens a finished Setup. A database whose
  principal a script created has no row, and its web chat stays with the coordinator even
  when the console is opened on it. If the call fails, the panel says its messages may
  reach Curia's usual chat.

### Out of scope

- Aligning the system timezone (cron scheduler, `TIMEZONE` env var) to the principal's
  timezone — tracked as a follow-up.

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
by the skill bundle. Since #2358 it lists the operator's Setup steps only: required
steps (Who it's for, Curia's name, Email, Messaging, Voice, Email & calendar) and
optional extras. `src/setup/checklist.ts` runs each task's check, and both the console
(`GET /api/setup/checklist`) and `setup-status` read that one computation, including
`setup_complete`: true when every required step is done, which unlocks Start
onboarding (`POST /api/setup/complete`). Only optional extras can be deferred. Who
Setup is for, the operator's details, the chosen messaging and voice routes and the
Setup phase are kept in the `setup_state` table (migration 130), not the knowledge
graph. The agent can show the full menu on request and can resume deferred extras in
any subsequent session.

A task can carry an `optional_upgrade`: a credential that improves something that
already works. Web research is the one example (#2445). It reports done with no key,
since search runs Tavily keyless, and `setup-status` lists `tavily_api_key` as an
upgrade with a `configured` flag. The wizard never asks for an upgrade key during
setup. It offers the key on request, or after search reports it is temporarily
limited, using the same one-time capture link as other keys.

### The setup guide (#2358)

Since #2358 the `setup-wizard` agent is a setup guide: it explains, compares options and
troubleshoots from `setup-status`, and never records anything about the principal. The
instant wins above (persona, debrief, pronouns, the tour) moved to onboarding (#2360).

- **On the Setup page.** While the `setup_state` phase is `in_progress` (from the Setup
  page's first save until Start onboarding), `web` chat goes to the setup guide instead of
  the coordinator, with none of the principal-turn extras (turn guidance, backlog, live
  lanes). The chat route decides when it accepts the message, from one snapshot of the
  shared thread and the phase (`readWebThreadAndSetupPhase`), and stamps the inbound; the
  dispatcher routes on that stamp, read only on `web`. A message accepted just before Start
  onboarding therefore stays on the Setup thread with the setup guide. `POST /api/chat/messages` takes an optional `setupStep` (the open
  step's catalog id, or `apply` / `start`); the runtime heads the turn with a
  "[Setup page: ...]" line naming it (`none` when the client sent none), so the agent knows
  it is talking to the operator. A database with no `setup_state` row (a scripted install)
  keeps web chat with the coordinator.
- **Kept out of the principal's memory.** The dispatcher schedules no conversation
  checkpoint for a setup guide turn on `web`, so fact and relationship extraction never
  read the Setup chat. Start onboarding (`POST /api/setup/complete`) moves the shared web
  thread to a new conversation and marks Setup complete in one transaction under a row
  lock (`completeSetup`), so the thread rotates once however often it is pressed. The
  principal never opens on the Setup chat, which stays in `working_memory` and the audit
  log. Thread reads that started before a rotation never cache the old id.
- **After Setup** the coordinator still delegates "help me set up X" to it, and relays its
  answer.

### Skills pinned to setup-wizard

- `setup-status` — read-only; returns the Setup checklist with each task's live status, `setup_for` and `setup_complete`
- `setup-defer` — write; persists or clears deferrals of optional extras
- `system-secret-capture-request` — a one-time link for a one-key secret
- `tool-registry` — read-only
- `mailbox-signin-link` — a single-use mailbox sign-in link

It has no tool that writes preferences, memory, the executive profile, contacts or
schedules (`tests/unit/agents/setup-guide-tools.test.ts`). Pinning prevents reliance on
dynamic discovery; `allow_discovery: false` and `inject_specialists: false` keep the agent
focused.

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
auth guard sees inSetup === true
  ↓  redirects to /setup
[ Setup page ]                                    ← Layer 2 (#2358)
  Who it's for → PUT /api/setup/state, POST /api/setup/principal(/profile)
  Curia's name → PUT /api/identity → POST /api/identity/reload
  Email, Messaging, Voice, Email & calendar → keys, routes and the principal's ids, inline
  Apply & restart → POST /api/system/restart, poll GET /api/system
  Start onboarding (unlocked by setupComplete) → POST /api/setup/complete
       → the web thread rotates; the console loads afresh, out of Setup
the principal's first conversation                ← onboarding (#2360)
```

---

## Related specs

- [02 — Agent System](02-agent-system.md) — coordinator delegation, specialist routing
- [03 — Skills & Execution](03-tools-and-execution.md) — `action_risk`, capability injection
- [13 — Office Identity](13-office-identity.md) — `OfficeIdentity` schema, `OfficeIdentityService`, HTTP API
- [14 — Autonomy Engine](14-autonomy-engine.md) — `action_risk` enforcement
