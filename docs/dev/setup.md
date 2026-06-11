# Development Setup

This guide gets your local Curia instance running. Setup is organized into three tiers — start with the minimum and add services as needed.

| Tier | Services | What you get |
|---|---|---|
| **1 — Minimum** | Anthropic + Postgres | Agents running, CLI and web app working |
| **2 — Recommended** | + Nylas + OpenAI | Email channel active, entity memory and semantic search working |
| **3 — Full** | + Tavily + Signal | Web research skill, encrypted Signal messaging |

Complete each tier before moving to the next.

---

## Prerequisites

Install these before anything else:

- **Node.js 22+** — check with `node --version`
- **Docker and Docker Compose** — Postgres runs in Docker; install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or the standalone CLI
- **pnpm** — `npm install -g pnpm`
- **openssl** — used by `pnpm run setup` to generate secrets; usually
  pre-installed on macOS and Linux. Verify with `openssl version`.

---

## Tier 1 — Minimum

Everything you need to run Curia and interact with it via the CLI and web app.

### 1. Clone and run setup

```bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm run setup
```

`pnpm run setup` runs `scripts/setup.sh`, which handles every Tier 1 step
for you:

1. Checks prerequisites (`docker`, `docker compose`, Node 22+, `pnpm`, `openssl`).
2. Generates `DB_PASSWORD`, `API_TOKEN`, and `WEB_APP_BOOTSTRAP_SECRET`
   with `openssl rand -hex 32`.
3. Prompts for your **Anthropic API key** (validated against `sk-ant-...`,
   3 retries).
4. Writes `.env` from `.env.example`, leaving optional channel vars
   (Nylas, OpenAI, Tavily, Signal) commented out for Tiers 2 and 3.
5. Starts the Postgres container, waits for it to be healthy, and applies
   all database migrations.
6. **Seeds the encrypted secrets vault** from the values it just generated
   and prompted for. Secrets resolve from the vault only — there is no
   `.env` fallback (see [ADR-021](../adr/021-vault-only-secret-resolution.md)),
   so this runs before first boot to avoid an empty-vault failure.
7. Runs `pnpm install --frozen-lockfile` if `node_modules/` is missing
   (skipped on re-runs).
8. Brings up the full stack (`docker compose up -d`) and polls Curia's
   healthcheck so the success banner only fires once the app is actually
   responding.
9. Appends `# SETUP_COMPLETE` to `.env` as a clean-finish marker and prints
   a summary box with `http://localhost:3000` and your bootstrap secret.

**Save the bootstrap secret to a password manager** — the script will not
show it again. If you need to recover it, it's in `.env` as
`WEB_APP_BOOTSTRAP_SECRET=...`.

> **Re-running `pnpm run setup`:** If `.env` already exists, the script
> presents a menu — start the stack (default), resume an interrupted setup,
> or do a full reset. See [spec 18 — Onboarding](../specs/18-onboarding.md#re-entry-path)
> for what each option does.

### 2. Verify

**Web app:** Open `http://localhost:3000` in your browser. You'll be
prompted for your `WEB_APP_BOOTSTRAP_SECRET`. The next step (Tier 1, §3)
walks through the in-app setup that finishes immediately after login.

**CLI:** If you want a CLI interface alongside the web app, run `pnpm local`
in a separate terminal — it attaches a CLI channel to the running stack.

### 3. Personalize your instance

After logging in for the first time, the app detects that the office identity
has not been configured and redirects you to `/setup` automatically. This is
a five-step React form wizard:

1. **About you** — the CEO's name (the principal contact). Auto-skipped if
   a principal already exists (e.g. you set `CEO_PRIMARY_EMAIL` before first
   boot).
2. **Identity** — assistant name, title, optional email signature.
3. **Tone** — 1–3 baseline tone words + verbosity and directness sliders.
4. **Posture** — decision-making posture + initial behavioral preferences.
5. **Review** — confirm and save.

When you submit step 5, the wizard saves the identity, hot reloads it, and
(if the process booted in setup-required mode) asks the supervisor to
restart so the email and Signal channels can come online. You'll see a
brief "Setting up channels…" screen during the restart, then land directly
in the chat view at `/chat`. The `setup-wizard` specialist agent
automatically introduces itself and asks about your priorities, working
hours, and debrief cadence. Reply to it like you'd talk to any agent —
preferences captured here are appended to the same office identity the
form wizard wrote.

The whole personalization step takes a few minutes. You can come back to
`/setup` directly any time you want to revise the identity by hand. The
full design is documented in
[spec 18 — Onboarding](../specs/18-onboarding.md).

> **Checkpoint:** Curia is running, your identity is configured, and the
> coordinator is personalized. Stop here or continue to Tier 2 for email
> and embeddings.

---

## Adding secrets after setup

Tiers 2 and 3 add credentials (Nylas, OpenAI, Tavily, Signal). These are
**secrets**, and secrets resolve from the encrypted vault only — there is no
`.env` fallback (see [ADR-021](../adr/021-vault-only-secret-resolution.md)).
Setting a key in `.env` alone has no effect.

To add or update a secret, pass it as a transient env var to the seeder:

```bash
NYLAS_API_KEY=nyk_v0_... pnpm run seed-vault
```

The seeder upserts the value into the vault (re-running is safe; absent values
are skipped, never cleared). You can pass several at once. Then restart Curia so
the relevant channel or skill picks the secret up. The env-var snippets in the
tiers below name the variables to seed.

> Only the four vault-bootstrap values (`DB_USER`, `DB_PASSWORD`,
> `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`) plus non-secret config (`TIMEZONE`,
> `CEO_PRIMARY_EMAIL`, etc.) belong in `.env`. Everything else goes through the
> vault.

---

## Tier 2 — Recommended

Adds the email channel and knowledge graph embeddings. This gives you a realistic development environment close to how Curia is actually used.

### Nylas (Email)

Curia uses [Nylas](https://nylas.com) as its email layer — a unified API that handles the IMAP/SMTP complexity and provides a consistent interface across Gmail, Outlook, and other providers.

**1. Create a Nylas account**

Sign up at [app.nylas.com](https://app.nylas.com). The free tier is sufficient for development.

**2. Create an application**

In the Nylas dashboard, create a new application. Choose "Email" as the product. Once created, copy your **API key** — this is your `NYLAS_API_KEY`.

**3. Connect an email account**

In your application, go to **Grants** and add a new grant. This connects an email account (Gmail, Outlook, etc.) to your Nylas application via OAuth. Use the email address you want Curia to read and send from.

After completing the OAuth flow, the grant appears in your dashboard. Copy the **Grant ID** — this is your `NYLAS_GRANT_ID`.

> **Note:** For development, using a dedicated email account (rather than your primary inbox) is strongly recommended. Curia will read and process all incoming messages.

**4. Set the email address**

`NYLAS_SELF_EMAIL` is the address of the connected account — the address Curia reads and sends from:

Seed all three into the vault (see [Adding secrets after setup](#adding-secrets-after-setup)):

```bash
NYLAS_API_KEY=nyk_v0_... \
NYLAS_GRANT_ID=<grant-id-from-dashboard> \
NYLAS_SELF_EMAIL=curia@yourdomain.com \
pnpm run seed-vault
```

Restart Curia (`pnpm local`) — the email channel activates automatically when all three Nylas secrets are in the vault.

> **Multiple email accounts:** The three vars above wire up a single "legacy" email account. To configure multiple named accounts with per-account outbound policies (e.g. a Curia account that sends directly and a personal account that requires your approval), use `channel_accounts.email` in `config/local.yaml`. See [configuration.md](configuration.md#configlocalyaml--deployment-overrides) for details and an example.

### OpenAI (Embeddings)

OpenAI's embedding model (`text-embedding-3-small`) powers entity memory and semantic search in the knowledge graph. Without it, KG lookups are exact-match only and smoke tests are unavailable.

Get an API key from [platform.openai.com](https://platform.openai.com) and seed it into the vault:

```bash
OPENAI_API_KEY=sk-... pnpm run seed-vault
```

> **Checkpoint:** Email channel active, knowledge graph fully functional with semantic search. This is the recommended baseline for most development work.

---

## Tier 3 — Full

Adds web research capability and (when available) Signal messaging.

### Tavily (Web Search)

Powers the `web-search` skill, which lets agents research topics and look up current information.

`web-search` is **excluded from the default core set** and is **gated by `install.requires_secrets: [tavily_api_key]`** — it cannot be installed or enabled until the Tavily key exists in the vault. This makes it the reference flow for provisioning a skill secret through the console.

**Provision via the console (recommended):**

1. Sign up at [tavily.com](https://tavily.com) and copy your API key (`tvly-...`).
2. In the console, open **Settings → Skills → web-search → Required secrets**. `tavily_api_key` shows as **missing** and **Install & enable** is disabled.
3. Paste the key inline. It is stored encrypted in the vault; the status flips to **configured** and the button enables.
4. Click **Install & enable**. Enforcement is **restart-based** — the skill registers and becomes usable on the next process restart.

**Alternative (dev shortcut):** seed the key into the vault directly, then enable web-search in the console:

```bash
TAVILY_API_KEY=tvly-... pnpm run seed-vault
```

`ctx.secret('tavily_api_key')` resolves **vault-first** with a `TAVILY_API_KEY` env-var fallback. In production the vault is the single source of truth — do **not** leave `TAVILY_API_KEY` set in the deploy environment, since a lingering env var would mask whether the vault entry is actually being used.

> **Revocation caveat:** the install/enable gate checks the **vault only**, but the runtime resolver falls back to the env var. So if `TAVILY_API_KEY` is still set, *deleting `tavily_api_key` from the vault does not revoke web-search* — the skill keeps working off the env var, and only the `secret.accessed` event (`source: env`) reveals it. Treat removing the env var as a prerequisite for vault-based key rotation/revocation, not just initial setup.

### Signal

Signal messaging runs via [signal-cli](https://github.com/AsamK/signal-cli). The socket path is wired up automatically by Docker Compose — the only thing you need to set is your phone number.

**1. Bootstrap signal-cli**

Signal requires registering a phone number with signal-cli and seeding the `signal-data` Docker volume with the resulting credentials. Refer to your deployment documentation for the bootstrap procedure.

**2. Seed the phone number**

```bash
SIGNAL_PHONE_NUMBER=+12223334444 pnpm run seed-vault
```

That's the E.164 number you registered via `signal-cli register` + `verify`. `SIGNAL_SOCKET_PATH` is managed by the deployment layer — do not set it in `.env`.

Restart Curia — the Signal channel activates when `SIGNAL_PHONE_NUMBER` is set and the signal-data volume is populated.

---

## What's Next

If you walked through Tier 1, you've already configured the office identity
and met the `setup-wizard` agent. From here:

- **Use the chat view.** Open `http://localhost:3000/chat` and start
  talking to the coordinator. This is the primary surface for everyday use.
- **Or use the CLI.** Run `pnpm local` in a terminal — it attaches a CLI
  channel to the running stack. Type a message at the prompt.

If you want to dig deeper, the [architecture overview](../specs/00-overview.md)
explains how the layers fit together, and the [agent](adding-an-agent.md)
and [skill](adding-a-skill.md) guides cover the most common extension points.
The end-to-end onboarding flow is documented in
[spec 18 — Onboarding](../specs/18-onboarding.md).

To enable Google Drive access (for expense trackers, job application
trackers, and other persistent documents), see [google-drive.md](google-drive.md).

---

## Troubleshooting

**macOS: HTTPS requests fail with "unable to get local issuer certificate"**

Node installed via nvm or fnm bundles its own CA store and doesn't trust macOS system certificates. Export your system certs and point Node at them:

```bash
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > ~/.config/curia/macos-ca-certs.pem
```

Then uncomment in `.env`:

```env
NODE_EXTRA_CA_CERTS=/Users/yourname/.config/curia/macos-ca-certs.pem
```

**Postgres connection refused**

Make sure the Docker container is running (`docker compose ps`). If the container is healthy but Curia can't connect, confirm the credentials in `.env` match the values in `docker-compose.yml`.

**Email channel not activating**

All three Nylas vars (`NYLAS_API_KEY`, `NYLAS_GRANT_ID`, `NYLAS_SELF_EMAIL`) must be set. If any are missing, the channel disables itself at startup. Two possible log messages:

- `NYLAS_API_KEY/NYLAS_GRANT_ID not set — email channel disabled` — the API key or grant ID is missing
- `NYLAS_SELF_EMAIL not set — email adapter disabled` — the first two vars are set but `NYLAS_SELF_EMAIL` is missing
