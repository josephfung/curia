# 18 — Onboarding

**Date:** 2026-06-01
**Status:** Shipped (v0.32; Layer 2 expanded in v0.37; Layer 3 rewritten in v0.37; Layer 4 added in #2360)

## Goal

Take a new contributor from `git clone` to a working, personalized Curia
instance in one path with no detours. The onboarding flow spans four layers:

1. **Host bootstrap** — a single `pnpm run setup` command brings up Postgres,
   applies migrations, and starts the stack.
2. **Setup page** (`/setup`, #2358) — the operator's checklist: who Curia is for,
   Curia's name, its channels, Apply & restart, then Start onboarding or Not right now.
3. **In-chat specialist** (`setup-wizard` agent) — an outcome-backward concierge
   that runs on first chat and whenever the principal asks for help setting up
   integrations; catalog-aware and deferral-aware.
4. **Onboarding** (#2360) — Curia does its homework on the principal, greets them,
   and learns how they like to work in a first conversation by chat or voice.

The layers are independent (each can be re-entered or skipped), but
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
six-step form wizard. It is the console's landing page on a new install until Setup is
finished (Start onboarding or Not right now), and an install that predates it never sees
it. Design and mockup:
`docs/wip/2026-10-29-onboarding-journey-design.md` (Phase 1) and
`docs/wip/2026-10-29-onboarding-journey-design/setup-page-mockup.html`.

### Routing

- `/setup` is its own full-screen route in `apps/console/src/router.tsx` (no sidebar or
  topbar), behind the same auth guard as the rest of the console. `?step=<id>` opens one
  step directly; without it the page opens on the first required step that isn't done.
- The first-load gate is `setupRedirect` (`pages/setup/setup-steps.ts`), fed by
  `GET /api/identity`'s `inSetup` (true from a new install's first load until Setup is
  finished; migration 132, which replaced `setup_state`, marks older installs complete).
  While Setup runs, every page but the Setup page and the Settings pages its steps link to
  (`/settings`, `/system`, `/channels`, `/tools`, `/agents`, `/mcp-skills`, `/secrets`,
  `/contacts`) redirects to `/setup`; outside Setup, `/setup` redirects home. A server that
  predates `inSetup` falls back to the older `configured` flag.

### Steps

The step list shows each step's mark from the Setup checklist (`GET /api/setup/checklist`,
the same computation as the setup agent's `setup-status`): done, waiting for a restart,
not done, or locked. Status shows as one line inside the open step. The steps are grouped
Basics, Curia's channels, Business Apps (Email & calendar and Google Workspace, and later any
other business application Curia is authorized for) and Finish.

| Step | Saves | Through |
|------|-------|---------|
| Who it's for | Myself or someone else; for someone else, the operator's name and email; the principal's name, title, email, timezone and pronouns | `PUT /api/setup/state` (first, which starts Setup), `POST /api/setup/principal`, `POST /api/setup/principal/profile` |
| Curia's name | Name, title, email signature (a suggested first name on a new install, #799) | `PUT /api/identity` (`changedBy: 'wizard'`, the assistant block only) and `POST /api/identity/reload` |
| Email | The Nylas API key, then Curia's own mailbox (Connect with Google, or a pasted grant ID); the email channel is turned on once both are there | `PUT /api/vault/secrets/channel.email.nylas_api_key`, the email accounts routes, `POST /api/registry/channels/email/{install,enable}` |
| Messaging | The route (the Curia app, Signal, SMS or Slack), that route's credentials, and the principal's id on it (Signal number, mobile, Slack member id), linked to their contact. Nothing is sent to the principal | `PUT /api/setup/state`, the vault, the channel routes, `POST /api/contacts/:id/identities` |
| Voice | The route (the app or a Signal call; Phone shows as coming soon), the Deepgram and Cartesia keys and Curia's voice. LiveKit's keys come with the install (#2689). A Signal call also takes Signal's credentials and the principal's number when messaging isn't Signal | `PUT /api/setup/state`, the vault, the channel routes |
| Email & calendar | The Nylas API key again (the same key, so the step stands alone), the Nylas sign-in checks, and Connect with Google for the principal | the vault, `/api/registry/nylas/*` |
| Google Workspace | Curia's Google address and the OAuth client ID and secret, then Sign in as Curia (#2683). Required: the deep dive delivers its drafts as Google Docs (#2362). Done means Google accepts the saved token (a live refresh, with the saved OAuth client) and the google-workspace MCP server is enabled, so an install signed in by hand reads done once its server is on. The console sign-in enables the server itself. A sign-in restarts Curia once | `PUT /api/vault/secrets/{curia_google_email,google_oauth_client_id,google_oauth_client_secret}`, `/api/google-workspace/{status,signin}`, then Google's redirect to the public `/api/google-workspace/callback` and `/google-workspace/done` |
| Apply & restart | One restart turns on everything saved; every step is checked again | `POST /api/system/restart`, then `GET /api/system` until `bootedAt` changes |
| Start onboarding | Locked until `setupComplete`, listing what's left. Two choices, and both end Setup. **Start onboarding** finishes Setup, then starts onboarding ([Layer 4](#layer-4--onboarding-2360)), which rotates the web thread so the principal never opens on the Setup chat; the step shows the invitation link with wording to send (the Curia app) or says Curia has said hello (Signal, SMS, Slack). **Not right now** asks for confirmation first, worded for who Setup is for ("It's required before Curia acts for them. … Curia won't contact them until you do"), then finishes Setup without starting onboarding: the thread is not rotated, and the dashboard shows an "Onboarding hasn't started" alert with a Start onboarding button until it has run. Either way the console then loads afresh | `POST /api/setup/complete` (marks Setup complete, nothing else); Start onboarding also `POST /api/onboarding/start` |

Every field a step needs is on the step, so an operator never has to leave Setup. A channel
is turned on as soon as its required credentials resolve; it starts at Apply & restart.

### Optional extras

Listed under "Optional extras" after Start onboarding, unnumbered ("Optional extra" in the
eyebrow), and never counted toward the required steps or `setupComplete`. Save and continue
walks them in order; the last returns to Start onboarding. An extra is ticked only once
something is set up: the search limit when the Tavily key is (`optional_upgrade.configured`). Working style is never ticked, since its
check is always done.

| Extra | Saves | Through |
|-------|-------|---------|
| Working style | A tone (one of the four tone templates) and an independence level: Draft only, Ask first (the default) or Spot-check, at scores 65, 75 and 85. Each saves when picked. They are a starting point: the principal is offered them in the first conversation and can change them | `PUT /api/identity` (`tone.style` only, `changedBy: 'working_style'`, which doesn't tick Curia's name); `PUT /api/autonomy` |
| Higher search limit | The Tavily key, with links to tavily.com and the curia-docs limits page | `PUT /api/vault/secrets/tavily_api_key` |
| Capabilities | Switches over the registry (below). Meetings always on; Email triage off and locked ("Left for <principal> to choose, later in Settings") | `POST /api/registry/:kind/:name/{install-enable,disable}` |

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
| Diagnostics | `diagnostics` agent and bundle (opt-in on a new install, #1356: reads the audit log and working records; `powerful` tier) | |
| Email triage | `ceo-inbox` agent, `ceo-inbox` and `learning` bundles | Off in Setup: it acts on the principal's inbox, so it is left for them to choose afterwards |

- A switch shows on, off, "Partly on" (some entries on, or a bundle tool switched alone, on
  under a disabled bundle or off under an enabled one: switching sets them all), or "Not
  available" (an entry missing or with a broken manifest). It is a tri-state checkbox drawn
  as a switch, so "Partly on" reads as mixed.
- Turning on enables what the capability pins before its agents, and re-enables a bundle
  whose tools were turned off alone; turning off disables the agents first, and turns off a
  tool left on alone under a disabled bundle. Calls run one at a time through the existing
  `/api/registry` routes; a failure stops there and says whether part of it changed.
- Turning on also offers to turn on the capabilities its agents need: those its agents pin,
  and those the catalog lists (`needs`: Meeting debriefs and Email triage need Projects and
  tasks, even when a bundle manifest can't be read). A needed one that isn't available stops
  the switch with a message. An on capability whose needs are off says "Needs ...".
- Only catalog entries are switched. An agent's pins outside the catalog (Meeting debriefs'
  `calendar-list-events`, say) are left as they are, so turning a capability on doesn't
  guarantee everything its agents pin is on.
- Before turning off, enabled agents outside the capability that pin one of its bundles (or
  a bundle tool directly) are named, and the operator confirms. Web research and Projects
  and tasks always warn: the coordinator pins `web` and `tasks`.
- Registry changes apply at the next restart: in Setup, at Apply & restart.
- While onboarding holds Email triage ([Layer 4](#the-triage-hold)), its switch reads
  "Held until <principal> hears what to expect" and shows off. Switching it on releases the
  hold (`DELETE /api/onboarding/triage-hold`), live, with no restart.

### The setup guide panel

The setup agent as a help panel; it never drives Setup.

- **Layout.** A full-height column docked to the right edge (`SetupGuidePanel`), on the page
  background past one thin line; the page makes room for it. Below 1,180px wide the step list
  hides while it is open, and its Steps button closes it; on a phone it is full-screen.
- **When it opens.** Only when asked: it starts closed, since the steps explain themselves.
  An empty thread opens on a greeting that lives in the panel only (never saved, never sent
  to the model). Each step's "Need help? Ask the setup guide"
  opens it with "I'm on the <step> step." in the composer, focused and unsent. The link is
  hidden while the panel is open.
- **No new chat endpoints or components.** It renders `ChatThread`, `ChatComposer` and
  `useChatSession` over `/api/chat/*`. `useChatSession({ setupStep })` sends the open step as
  `setupStep` on `POST /api/chat/messages`; the server keeps it only while Setup runs and the
  setup agent reads it as a `[Setup page: ...]` line. `ChatComposer` takes a `draft`.
- **Step markers.** When the open step changes, a "Now on: <step>" line appears in the
  thread. They live in the panel only, not in the saved history.
- **Setup starts when the page opens.** `POST /api/setup/start` writes nothing: the phase
  is derived from `settings`' `setup.completed_at` marker (ADR-067), so an install without
  one is in Setup and web chat reaches the setup guide from the first message. It never
  reopens a finished Setup. A database with no Setup settings at all (a scripted install)
  also reads as in progress, which matches the console already showing it the Setup page;
  its web chat reaches the setup guide once the console is opened on it. If the call fails,
  the panel says its messages may reach Curia's usual chat.

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
`setup_complete`: true when every required step is done, which unlocks the last step
(Start onboarding or Not right now; both `POST /api/setup/complete`). Only optional
extras can be deferred. Who
Setup is for, the operator's details, and the chosen messaging and voice routes are kept in
the `settings` table through the typed registry in `src/settings/` (migration 132,
[ADR-067](../adr/067-typed-key-value-settings-store.md)), not the knowledge graph. There is
no stored phase or `setup_for`: an `operator` value means "someone else" and an absent one
means "myself", and the phase is `in_progress` until `setup.completed_at` is set. The agent
can show the full menu on request and can resume deferred extras in any subsequent session.

A task can carry an `optional_upgrade`: a credential that improves something that
already works. Web research is the one example (#2445). It reports done with no key,
since search runs Tavily keyless, and `setup-status` lists `tavily_api_key` as an
upgrade with a `configured` flag. The wizard never asks for an upgrade key during
setup. It offers the key on request, or after search reports it is temporarily
limited, using the same one-time capture link as other keys.

### The setup guide (#2358)

Since #2358 the `setup-wizard` agent is a setup guide: it explains, compares options and
troubleshoots from `setup-status`, and never records anything about the principal. The
instant wins above (persona, debrief, pronouns, the tour) moved to onboarding
([Layer 4](#layer-4--onboarding-2360)).

- **On the Setup page.** While Setup is in progress (`settings`' `setup.completed_at`
  absent: from a new install until Setup is finished), `web` chat goes to the setup guide
  instead of the coordinator, with none of the principal-turn extras (turn guidance,
  backlog, live lanes). The chat route decides when it accepts the message from the shared
  thread and the phase (`readWebThreadAndSetupPhase`, two reads; the settings store validates
  the phase value) and stamps the inbound; the dispatcher routes on that stamp, read only on
  `web`. The two reads can produce (Setup thread, complete) when Setup finishes in between:
  that message goes to the coordinator on the Setup thread, the same outcome as a message sent
  after "Not right now", which keeps the Setup chat by design. A message whose phase read still
  sees Setup in progress is stamped for the setup guide and stays on the Setup thread with it.
  `POST /api/chat/messages` takes an optional `setupStep` (the open step's catalog id, or
  `apply` / `start`); the runtime heads the turn with a "[Setup page: ...]" line naming it
  (`none` when the client sent none), so the agent knows it is talking to the operator. A
  database with no settings at all (a scripted install) reads as in progress, so its web
  chat reaches the setup guide once the console is opened on it.
- **Kept out of the principal's memory.** The dispatcher schedules no conversation
  checkpoint for a setup guide turn on `web`, so fact and relationship extraction never
  read the Setup chat. Finishing Setup (`POST /api/setup/complete`, `completeSetup`) only
  marks it complete. Starting onboarding from the console moves the shared web thread to a
  new conversation, inside the start's transaction under its advisory lock
  (`OnboardingService.start`), so the thread rotates once however often Start is pressed,
  and an operator who chose Not right now keeps their Setup chat until then. The
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
| `sensitivity` | `elevated` (a live principal turn, or the principal's approval) |
| `allowed_callers` | `coordinator` |

Persistence calls `OfficeIdentityService.update(...)` with `'tool'` as the
`changedBy` value, producing an `office_identity_versions` row per change.
See [13 — Office Identity](13-office-identity.md#officeidentityservice) for
the underlying service contract.

### Out of scope

- In-app Nylas OAuth flow and grant capture.
- In-app Telnyx OAuth / automated DID purchase (SMS uses Mission Control + vault; see ADR-036 / setup catalog).
- Signal channel verification.

---

## Layer 4 — Onboarding (#2360)

Onboarding is Curia adapting to the principal: it does its homework, greets them, learns how
they like to work in a first conversation (about half an hour, by chat or voice), applies each
choice while they are present, and books later sessions one at a time. Design:
`docs/wip/2026-11-20-onboarding-program-design.md`.

It is built from what Curia already has: one ordinary task with a subtask per topic, an
editable playbook, the `onboarding` skill bundle (how Curia runs it), and a few guarantees in
code (`src/onboarding/`, `src/meetings/`). Nothing starts it on its own, so an existing
install never gets a greeting, research or a triage change unless someone starts it.

### Parts

| Part | What it is | Where |
|---|---|---|
| Playbook default | Curia's guide, in its own voice: a `#` section per session (`<!-- session: id -->`), a `##` subsection per topic (`<!-- topic: id -->`); `Needs: mailbox` marks a topic that waits for the mailbox. Sessions: First conversation, Review, Check-in, Ongoing rhythm, and Weekly (for recurring sessions after onboarding, never onboarding topics) | `config/onboarding/playbook.md` |
| Playbook | The install's copy, editable in Documents. Seeded when Setup starts (`POST /api/setup/start`) and again at Start if missing; never overwritten | OKF `/meetings/onboarding/playbook.md` |
| Research brief | What the homework found, each item with its source and marked unconfirmed until the principal confirms, corrects or drops it | OKF `/meetings/onboarding/research-brief.md` |
| Onboarding task | The coordinator's, owned by Curia, tagged `onboarding`, `created_by` `onboarding`. One subtask per topic, tagged `onboarding:topic:<id>` and `onboarding:session:<id>`, plus a homework subtask. The parent and the topics are `waiting` on the principal's contact; the homework is open with its own wake. Progress notes are what has happened | `tasks` |
| Run state | The task id, the route, greeting and follow-up times, the greeting re-wake, the principal's last turn, the idle nudge, the operator notices sent | config store `onboarding/state` |
| Triage hold | `{"held": true}` while triage waits for the inbox topic | config store `onboarding/triage_hold` |

Only subtasks the onboarding program created count as topics (`created_by`), since the model
can tag any task. The whole `onboarding` config-store namespace is code-owned: the
`config-store` tool refuses writes to it.

The playbook is seeded with `editable_by: console` in its frontmatter. That is a general
document setting, not an onboarding rule: `doc-write` refuses every mode on a document that
carries it unless the write is a principal-approved re-execution, and refuses any write that
adds, changes or removes the key, whoever calls. Agents that read untrusted mail hold
`doc-write`, so only the console (the documents API, which does not use `doc-write` and keeps
frontmatter as edited) changes the playbook. Since it is always seeded with the key and no
agent can remove it, a playbook found without it was planted (or predates the key): reading or
seeding it replaces it with the default, keeping nothing, and logs a warning. The research
brief is an ordinary document. The parser keeps ids to `[a-z0-9-]` (slugifying anything else)
and caps session and topic titles at 120 characters. Topic ids are read back from task tags,
which a model can edit, so a topic whose tag id is not `[a-z0-9-]{1,64}` is ignored (warned).

### Starting

The console starts it from the last Setup step or the dashboard alert, through
`POST /api/onboarding/start`. Start can mint an invitation, so it needs a signed-in console
session, not the access key alone. The principal can also ask ("can we do the onboarding?"):
the coordinator calls `onboarding-start`, the same path. Nothing else starts it.

Start is refused, with a code the console explains, when:

| Code | When | The console |
|---|---|---|
| `setup_incomplete` | Setup is not finished | re-reads the checklist |
| `already_started` | an onboarding task is open | says so |
| `start_in_progress` | another start held the lock past its 10-second timeout | treats it as `already_started` and refreshes |
| `no_persistent_store` | the knowledge graph is off, so the run state and the hold would not survive a restart | says to turn it back on |
| `confirm_working_principal` | the install already looks in use: Email triage is on, or the principal has tasks from before Setup finished | asks to confirm, then starts with `confirmWorkingPrincipal` |
| `route_unreachable` | no messaging route, `APP_ORIGIN` unset for the Curia app, or no verified principal identity on Signal, SMS or Slack | links Channels and the principal's contact |

Otherwise, under a transaction-scoped advisory lock (two presses serialize, and the second
sees `already_started`), Start:

1. **Holds triage** (below).
2. **Enables what onboarding needs:** the Email triage agent (`ceo-inbox`) and the `ceo-inbox`,
   `learning` and `tasks` bundles. If the running process did not load any of them at boot
   (whether this start or an earlier one enabled it), Curia restarts after it replies, and the
   wakes below are set a minute ahead so they fire on the new process. The console waits for
   the restart as Apply & restart does.
3. **Creates the task tree** from the playbook's First conversation session, with the
   `onboarding` skill active on the parent and the homework task.
4. **Rotates the web thread**, so the principal's first view is clean: on an operator start, or
   a principal start from any channel but the web app (where it would wipe their conversation).
5. **Reaches the principal** on the Setup route. The Curia app: mints the 48-hour invitation,
   shown once with copyable wording that mentions the 48 hours; the greeting goes out when it
   is redeemed (`pairing.invitation_redeemed`). Signal, SMS or Slack: the parent task wakes
   with "Send the greeting" and the coordinator writes it. There is no email invitation.
6. **Wakes the homework, then records the run state**, last, so a failed start leaves no state
   saying it started.

A failure part-way, or a failed COMMIT, undoes the start: the tasks it created are cancelled,
a minted invitation is stopped, the triage hold goes back to what it was (kept on if this
start newly enabled Email triage) and an earlier run state is restored. An invitation whose
audit record fails is stopped too; the console then shows onboarding as started
(`started_invitation_unaudited`) and points at Devices for a new link. Every console start,
and every release of the hold from the console, is recorded as a `config.change` naming the
console session.

A principal's own start reaches no one, and the greeting counts as sent. If it restarts
Curia, the exit waits 15 seconds so the turn can say Curia will be back, and the parent wakes
afterwards to pick the conversation back up (apologising if its last message did not go out).

**Started** (`GET /api/onboarding/status`) means an onboarding task is open, or the run
state's task completed. A cancelled onboarding is not started: the dashboard alert returns
and Start can run again.

**Not re-run by accident.** The coordinator's `onboarding-start` skill is for Curia's own onboarding
with the principal, never for onboarding a new hire, contractor or client. When a completed
onboarding exists (a done parent task, `created_by` `onboarding`, tagged `onboarding`) it
refuses unless called with `redo: true`, which is set only after the principal explicitly
confirmed redoing it from the start. The console's operator start is unchanged.

### Homework

The homework task researches the principal's professional public footprint (company, role,
city, public bio, recent news; never family, home or personal accounts) and writes the
research brief, flagging results that may belong to a namesake. If Curia's Google Workspace
is signed in, it also lists the shared drives and their top-level folders, names only.
Nothing from the brief reaches memory until the principal confirms it. A failed search is
an operator notice (`web_search_failed`), and "Tell me about yourself" starts open. The
homework wake completes its task once the brief is written; one still open when onboarding
completes is cancelled.

### The greeting and follow-ups

The greeting says who Curia is and who set it up, offers a first conversation of about half
an hour, and says how to have it by chat or voice. Nothing else, and never the research.

The onboarding watcher (`src/onboarding/watcher.ts`, every 15 minutes) acts only while an
onboarding task is open. Its timings are constants in `src/onboarding/constants.ts`, not
settings:

- **Follow-ups:** with no principal turn since the greeting, up to 2 follow-ups 48 hours
  apart, then the operator notice `greeting_unanswered`.
- **Greeting not recorded:** with no greeting recorded 48 hours after it was due (the start on
  Signal, SMS or Slack; the invitation's redemption on the app), the parent wakes once to send
  it if it did not go out and record it (`greeting_sent`); 48 hours after that wake, the
  operator notice `greeting_unanswered`.
- **Idle nudge:** when the principal goes quiet for 4 hours with First conversation topics
  still open, one nudge per silence; open topics carry to the next session. No nudge while
  the next session is booked (a pending wake of the onboarding task set for later, or a
  pending agenda it owns): a deferral or a session that ended is agreed quiet.
- **Expired invitation:** an unredeemed invitation past its 48 hours is the operator notice
  `invitation_expired`.

The backlog heartbeat leaves the parent and the topics alone because they wait on a person:
they are created `waiting` with `waiting_on_contact_id` set to the principal, which
`selectHeartbeatCandidates` skips, as it skips any task waiting on a contact. Onboarding moves
only on the watcher, events and the principal's replies, so an idle parent or topic is never
pushed to a disposition (a greeting outside the cap, a topic closed without the principal).
Working a topic changes no status: `topic_done` completes it from `waiting`. The principal
answering a message a wake of the parent sent resumes it (`in_progress`, the general task-wake
reply rule); the watcher sets it, or any onboarding task that waits on a contact and was
resumed, back to `waiting` on its next sweep. Without a
principal contact the tasks are created open, and the heartbeat may wake them.

### Running a session

**How a turn picks up onboarding.** A task wake (greeting, follow-up, nudge, a booked session)
restores the `onboarding` skill from the task's active skills. An ordinary principal message
carries no task id, so while an onboarding task is open a live principal turn on any channel
(including a voice `async-offramp` hand-off whose live-turn grant is active) gets the
`onboarding` skill and a short block naming the task and its open topics by id only, so no
operator-written text reaches the turn; titles and playbook text come from
`onboarding-progress` `status` (`src/onboarding/turn-context.ts`). Task-bound turns, Setup page turns and tool-allowlisted
turns do not. The turn is not bound to the task, so anything else in the message is handled
as usual. A failed lookup, or an `onboarding` skill that cannot be activated, leaves the turn
without the block. Nothing is added to the
coordinator's always-on prompt.

**The skill** (`skills/onboarding/SKILL.md`) has the coordinator take topics in any order,
mostly as multiple choice with a read-back after each, apply each choice as soon as it is
confirmed, then mark the topic done (or declined, with the reason). Side requests become
their own tasks, never "after onboarding". A named day ("can we do Thursday?") is booked and
confirmed in one line; a vague "later" gets two concrete times, once.

| Tool | Does | Risk |
|---|---|---|
| `onboarding-progress` | `status` (open and done topics with their playbook text, mailbox connected, greeting sent, who Setup was for, the operator's name); `open_session` (create a later session's topics; idempotent); `topic_done` (done or declined, with a note); `greeting_sent`; `operator_notice`. Onboarding completes when the Ongoing rhythm topics exist and every topic subtask is closed, checked after each `topic_done` and on every `status` | low |
| `office-tone-update` | Writes `tone.style` and/or `tone.verbosity` (0 to 100). No other agent writes tone | low |
| `onboarding-triage-release` | Lifts the triage hold, live. Refused until the inbox topic is done; a declined topic leaves triage held | low |
| `onboarding-start` | A start the principal asked for | low |

All four are the coordinator's only (`allowed_callers`). While an onboarding task is open,
`set-autonomy` accepts only 65 (Draft only), 75 (Ask first) and 85 (Spot-check); if the
lookup fails, or the tool has no task repository to look in, it logs a warning and applies no
limit.

**Chat.** The coordinator runs the session in the principal's thread; a principal chat turn
is already live, so principal-authorized writes apply without an approval prompt.

**Voice.** Before a voice session the coordinator parks an agenda (`meeting-agenda-park`)
from the open topics, their playbook text and, for "Tell me about yourself", the research
brief, with the onboarding task as its owner. The call loads it (#2359). Choices made on the
call are applied through `async-offramp` with a live-turn grant (#2495); the minutes
follow-up marks covered topics done.

**Wakes from events** (`src/onboarding/subscribers.ts`), each a progress note plus a
coordinator wake on the open onboarding task: the invitation redeemed (send the greeting in
the app, unless already greeted); `principal_mailbox.connected` (run the first look, pick up
the connect and inbox topics); a principal mailbox sign-in blocked (`admin_blocked`,
`org_internal`) is the operator notice `mailbox_signin_blocked`, with the Google client id to
trust.

### The triage hold

Agents load only at startup, so Start turns Email triage on in the registry and holds it
instead of switching it on mid-conversation.

- While `onboarding/triage_hold` is held, the inbox heartbeat (the only thing that wakes
  scheduled triage) does nothing, so no mail is labelled, archived, drafted or sent before
  the principal has been told what to expect. Principal-directed mailbox actions are
  unaffected, and the heartbeat's daily sweep of expired dedupe rows (no mailbox touched)
  still runs. A hold that is malformed or cannot be read counts as held.
- A missing key means no hold, so installs that never start onboarding keep triaging.
- `onboarding-triage-release` lifts it once the inbox topic is done; switching Email triage
  on in Capabilities lifts it too (`DELETE /api/onboarding/triage-hold`). Both are live.
- A stalled or cancelled onboarding keeps the hold: the safe state. Start can run again and
  creates a new task.

### Sessions on the calendar

At the end of each session Curia and the principal agree the next one, and only that one is
booked: a busy event on the principal's calendar with the principal the only attendee, or,
with no calendar yet, a scheduler job. Either way the onboarding task's own wake time is also
set to the agreed session time (`task-update` `wake_at`), which is what the idle-nudge check
reads as "next session booked": a pending (or, mid-wake, deferred) wake of the parent task, or a
pending agenda it owns.

**An agenda follows its event.** This is general to any calendar-tied agenda, not only
onboarding's. `meeting-agenda-park` takes `calendar_event_id`, `calendar_id` and
`owner_task_id`, stored in the agenda's frontmatter. With no webhooks, `AgendaEventSync`
(`src/meetings/agenda-event-sync.ts`, every 15 minutes) re-reads each pending event-tied
agenda's event by id:

| The event | What happens |
|---|---|
| Moved | the agenda's `scheduled_for` follows |
| Cancelled or gone | the agenda is closed, and the owner task wakes once to ask when instead |
| Unreadable (access refused, or its calendar no longer routes to a mailbox) | the owner task wakes once to check with the principal; the event is not read again |
| Unreachable (the principal's mailbox is missing, or a second mailbox needs a hint) | skipped each sweep, with the first failure time recorded in the agenda's `event_unreachable_since`; cleared when a read succeeds. The first failure is a warning, later sweeps info. After 24 hours of continuous failure it becomes Unreadable, and the owner task wakes once with a note naming the cause (the mailbox is disconnected, or one needs choosing) |
| All-day (no timed start and end) | the owner task wakes once to ask when to hold the session; the event is not read again |
| Starting within 15 minutes | the owner task wakes once to nudge the principal |
| Ended 30 minutes ago, nothing loaded | a no-show: the owner task wakes once. Onboarding sends one "missed you, when suits better?" and books the answer, unless the session happened in chat (then nothing is sent) |

Only an open coordinator task is woken (any other owner is logged as a warning), since the
console can edit agenda frontmatter. Any other read failure is retried next sweep. The 24-hour grace is `EVENT_UNREACHABLE_GRACE_HOURS` in `src/meetings/constants.ts`. Each
step is recorded before its wake, so a failed write never repeats one. An event-tied agenda
is due from 12 hours before its event until it is settled, instead of the ±12-hour window,
so a late call still loads it (`expires_at` still bounds it); a cancelled one never is.

### Operator notices

`notifyOperator` (`src/onboarding/notify-operator.ts`) records a progress note on the
onboarding task, logs a warning, and emails the operator through the one system-notice path,
`OutboundGateway.sendNotification` (#2710, [ADR-068](../adr/068-operator-notices.md)). The
watcher and the subscribers raise each event at most once per onboarding.

The events are `greeting_unanswered`, `invitation_expired`, `mailbox_signin_blocked` and
`web_search_failed`. All four are operator-routed in `NOTIFICATION_AUDIENCES`
(`src/notifications/audience.ts`), so the gateway addresses them: the operator's email when
Setup was for someone else, and the principal's when it was for them themself — a "Myself"
install behaves exactly as before. When Setup was for the principal themself, Curia also tells
them directly in the conversation.

The emailed text carries the event and, for a blocked sign-in, the Google OAuth client id to
trust. Nothing model-supplied reaches it: a tool call's `details` are context for the progress
note, the log and the `onboarding.operator_notice` audit row (key names only) and never the
email. Bodies carry no principal content — no message text, addresses or objectives.

`onboarding-progress` op `operator_notice` raises only `web_search_failed`: it is the one notice
only the model can see, and the other three are detected in code. It goes through the same
once-per-run dedupe as everything else (`OnboardingService.raiseOperatorNotice`), so a repeated
call emails once and adds no second note — and answers `{ alreadyRaised: true }` rather than a
failure, so the model does not retry it. `operatorNotified` records what was raised;
`operatorNoticeFailed` names events whose notice reached nobody, so the run state never claims
the operator heard something that was never sent.

**The confirmation notice is owed (#2710).** Saving an operator address from Setup or the console
attempts one short notice to it, recorded in the `operator_confirmation` settings key
(`{ email, attemptedAt, sentAt }`). Step 1 of a fresh install cannot send it — there is no email
account until the restart — so the notice is *owed*: boot (once the email adapters start),
`POST /api/onboarding/start` and the console's Operator page retry it while `sentAt` is null or the
address has changed. A delivery the adapter refuses or fails leaves it `failed`: `sendNotification`
returns false when the refusal arrives during its publish, and the gateway's
`onNotificationUndelivered` hook clears `sentAt` when it arrives later, so "sent" never outlives a notice that never
arrived. The console shows sent, pending or failed with the time, and a Setup save never blocks
on it, nor comes at the cost of the principal and profile saves that follow it.

### Done

The onboarding task completes when the Ongoing rhythm session has been opened and every
onboarding topic subtask is closed (completed or declined, in any order); its last topic
agrees an ongoing rhythm, which may be none. Only topic subtasks count: an open homework task
is cancelled then, and tasks the model parented under onboarding stay as they are. The check
runs after each `topic_done` and again on every `status`, so a completion that failed once is
retried. The principal can stop it ("stop the onboarding"), or it can be
cancelled from the console's task view; triage stays held until switched on.

### Scenario cases

`tests/scenarios/cases/48a`, `48b` and `48d`–`48g` (tag `onboarding`, evals, not in the
gate): the style and independence topics of the first conversation, a deferral to a named day,
a vague "later", a no-show, and a side request. The inbox topic has no case: the release tool
refuses until the topic is done (code, unit-tested), and forgetting the release fails safe
(triage stays held). A case's `seed.onboarding` gives its principal turn
production's onboarding block and skill (the test-mode stack's `onboardingTurnContext`); the
no-show wake restores the skill from `inbound.task.active_skills`. A vague "later" answered
vaguely again is not covered: a case has no multi-turn history.

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
  Start onboarding (unlocked by setupComplete) → POST /api/setup/complete,
                                                  then POST /api/onboarding/start
       → the web thread rotates; the console loads afresh, out of Setup
  (or Not right now → POST /api/setup/complete; the dashboard alert starts it later)
[ Onboarding ]                                    ← Layer 4 (#2360)
  homework → greeting (or the app invitation) → capped follow-ups
  first conversation by chat or voice → triage released → later sessions on the calendar
```

---

## Related specs

- [02 — Agent System](02-agent-system.md) — coordinator delegation, specialist routing
- [03 — Skills & Execution](03-tools-and-execution.md) — `action_risk`, capability injection
- [13 — Office Identity](13-office-identity.md) — `OfficeIdentity` schema, `OfficeIdentityService`, HTTP API
- [14 — Autonomy Engine](14-autonomy-engine.md) — `action_risk` enforcement
