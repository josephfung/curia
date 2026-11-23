# Development Setup

This guide covers two ways to run Curia:

- **Operator install (image):** for self-hosted deployments. Docker only; no Node, pnpm, or openssl required on the host. Start here if you just want to run Curia, not develop it.
- **Developer install (source):** for contributing to Curia or hacking on the code. Requires Node 26, pnpm, and openssl.

---

## Operator Install (Image)

Requires Docker (with the Compose plugin) and `curl`. No other tools needed.

**1. Create a working directory and download the installer:**

```bash
mkdir curia && cd curia
curl -fsSL https://raw.githubusercontent.com/josephfung/curia/<vX.Y.Z>/install.sh -o install.sh
```

Replace `<vX.Y.Z>` with the release tag you want (e.g. `v0.40.0`). Check [releases](https://github.com/josephfung/curia/releases) for the latest.

**2. Review the script before running it:**

```bash
less install.sh   # read it; it is short and well-commented
```

**3. Run the installer:**

```bash
bash install.sh
```

The installer will:

1. Check for Docker, the Compose plugin, and `curl`.
2. Fetch `docker-compose.yml`, `.env.example`, and the TLS overlay into the current directory.
3. Generate secrets for `DB_PASSWORD`, `API_TOKEN`, and `WEB_APP_BOOTSTRAP_SECRET`.
4. Prompt for your **Anthropic API key** (format-validated, 3 retries).
5. Ask about deployment topology: local only, public HTTPS (Caddy), or behind an existing reverse proxy.
6. Pull the published image, start Postgres, run migrations and vault-seed inside the container (no host `pnpm` or `openssl` required), then bring the full stack up.
7. Print a summary box with the bootstrap secret you need to sign in.

**Save the bootstrap secret to a password manager.** Use it on the login page at `http://localhost:3000` (or your configured domain) to create your account.

**Updating an operator install:**

```bash
docker compose pull
docker compose up -d
```

---

## Developer Install (Source)

For contributing or extending Curia. This path runs from source and requires local tooling.

This guide is organized into three tiers. Start with the minimum and add services as needed.

| Tier | Services | What you get |
|---|---|---|
| **1 - Minimum** | Anthropic + Postgres | Agents running, CLI and web app working, web research (keyless), entity memory on the bundled embedding model |
| **2 - Recommended** | + Nylas, optionally another embedding model | Email channel active |
| **3 - Full** | + Signal | Encrypted Signal messaging |

Complete each tier before moving to the next. Web search needs no key; a Tavily key is
an [optional upgrade](#optional-higher-web-search-limits-tavily-key) for higher limits.

---

## Prerequisites

Install these before anything else:

- **Node.js 24+:** check with `node --version`
- **Docker and Docker Compose:** Postgres runs in Docker; install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or the standalone CLI
- **pnpm:** `npm install -g pnpm`
- **openssl:** used by `pnpm run setup` to generate secrets; usually
  pre-installed on macOS and Linux. Verify with `openssl version`.

---

## Tier 1 - Minimum

Everything you need to run Curia and interact with it via the CLI and web app.

### 1. Clone and run setup

```bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm run setup
```

`pnpm run setup` runs `scripts/setup.sh`, which handles every Tier 1 step
for you:

1. Checks prerequisites (`docker`, `docker compose`, Node 26+, `pnpm`, `openssl`).
2. Generates `DB_PASSWORD`, `API_TOKEN`, and `WEB_APP_BOOTSTRAP_SECRET`
   with `openssl rand -hex 32`.
3. Prompts for your **Anthropic API key** (validated against `sk-ant-...`,
   3 retries).
4. Writes `.env` from `.env.example`, leaving optional channel vars
   (Nylas, embeddings, Tavily, Signal) commented out for Tiers 2 and 3 and the
   optional Tavily upgrade.
5. Starts the Postgres container, waits for it to be healthy, and applies
   all database migrations.
6. **Seeds the encrypted secrets vault** from the values it just generated
   and prompted for. Most secrets resolve from the vault only (see
   [ADR-021](../adr/021-vault-only-secret-resolution.md); `TAVILY_API_KEY` is
   the documented env-fallback exception), so this runs before first boot to
   avoid an empty-vault failure.
7. Runs `pnpm install --frozen-lockfile` if `node_modules/` is missing
   (skipped on re-runs), then `pnpm fetch:embedder`.

   The stack this script starts builds the image locally from your checkout
   (`docker-compose.dev.yml`), and that build downloads and verifies the bundled
   embedding model itself. `pnpm fetch:embedder` is for running Curia from source
   (`pnpm local`, `pnpm dev`) and for the integration tests that load the model: it
   downloads the pinned `all-MiniLM-L6-v2` files into `models/embedding/` (gitignored,
   about 24 MB) and verifies their checksums. It returns at once when the files already
   verify, so re-runs cost nothing. If it fails (for example, Hugging Face is
   unreachable), setup warns and carries on, since the Docker stack does not need these
   files; run `pnpm fetch:embedder` yourself before a source run. Without them a source
   run boots with entity memory off, and the log names this command.
8. Brings up the full stack (`docker compose up -d`) and polls Curia's
   healthcheck so the success banner only fires once the app is actually
   responding.
9. Appends `# SETUP_COMPLETE` to `.env` as a clean-finish marker and prints
   a summary box with `http://localhost:3000` and your bootstrap secret.

**Save the bootstrap secret to a password manager.** The script will not
show it again. If you need to recover it, it's in `.env` as
`WEB_APP_BOOTSTRAP_SECRET=...`.

> **Re-running `pnpm run setup`:** If `.env` already exists, the script
> presents a menu (start the stack, resume an interrupted setup, or full
> reset). See [spec 18 - Onboarding](../specs/18-onboarding.md#re-entry-path)
> for what each option does.

### 2. Verify

**Web app:** Open `http://localhost:3000` in your browser. You'll be
prompted for your `WEB_APP_BOOTSTRAP_SECRET`. The next step (Tier 1, §3)
walks through the in-app setup that finishes immediately after login.

**CLI:** If you want a CLI interface alongside the web app, run `pnpm local`
in a separate terminal. It attaches a CLI channel to the running stack.

### 3. Personalize your instance

After logging in for the first time, the console opens the Setup page at `/setup`
automatically, and keeps it as the landing page until you press Start onboarding. A
step list sits beside the open step's form; Save and continue walks the steps, and any
step can be opened directly, so you can come back to what's left:

1. **Who it's for:** yourself, or someone else (then your name and email, as Curia's
   operator), and the principal's name, title, email, timezone and pronouns.
2. **Curia's name:** the assistant's name, title and email signature.
3. **Email, Messaging, Voice, Email & calendar:** each shows whether it works yet and
   what it needs. Messaging and Voice ask how Curia reaches the principal (the Curia
   app, Signal, text message or Slack; a call in the app or on Signal); the keys go in
   the Settings page each step links to.
4. **Apply & restart:** one restart turns on everything you saved, then every step is
   checked again.
5. **Start onboarding:** unlocks once every required step is done, and hands Curia to
   the principal.

Note: the system timezone (cron scheduler, environment variable `TIMEZONE`) remains
env-driven, separate from the principal's timezone. Aligning it is tracked as a
follow-up. The full design is in [spec 18 - Onboarding](../specs/18-onboarding.md).

> **Checkpoint:** Curia is running, and the Setup page has who it's for and Curia's
> name. Stop here or continue to Tier 2 for email and, optionally, a different
> embedding model.

---

## Adding secrets after setup

Tiers 2 and 3 add credentials (Nylas, an embedding server's key, Signal), and the optional
Tavily key raises web search limits. These are
**secrets**, and most of them resolve from the encrypted vault only (see
[ADR-021](../adr/021-vault-only-secret-resolution.md)) — setting the key in
`.env` alone has no effect. The one documented exception is `TAVILY_API_KEY`,
which the web-search resolver reads vault-first but with an env-var fallback
(see the Tavily section below).

To add or update a secret, pass it as a transient env var to the seeder:

```bash
NYLAS_API_KEY=nyk_v0_... pnpm run seed-vault
```

The seeder upserts the value into the vault (re-running is safe; absent values
are skipped, never cleared). You can pass several at once. Then restart Curia so
the relevant channel or skill picks the secret up. The env-var snippets in the
tiers below name the variables to seed.

To **remove** a secret (for example a Tavily key that has been revoked), open
**Memory → Secrets** in the console and choose **Remove** on its row. The seeder never
clears a value, so the console is the way back. Optional secrets can also be removed from
the tool's drawer under **Settings → Tools**.

Two things to know before relying on a removal:

- **Environment fallbacks survive it.** Removing a secret deletes the vault row only. A tool
  secret falls back to the upper-cased env var (`tavily_api_key` → `TAVILY_API_KEY`), and a
  channel credential to its catalog `envFallback`. If one is set, web search keeps using the
  Tavily key and the channel keeps its token. The Secrets page marks such a row
  **from environment** and names the variable; unset it in the deploy environment to finish
  the removal.
- **When it takes effect.** Tool secrets are re-read on every call, so a removal bites on the
  tool's next call. Channel credentials and MCP server keys are read at
  boot, so the old value keeps working until the next restart. Removing a leaked channel
  token does not revoke it; revoke it at the provider as well.

> Only the four vault-bootstrap values (`DB_USER`, `DB_PASSWORD`,
> `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`) plus non-secret config (`TIMEZONE`,
> etc.) belong in `.env`. Everything else goes through the vault. The principal's
> email is not env config; it's set in the onboarding wizard and lives in the
> contacts store.

---

## Tier 2 - Recommended

Adds the email channel, and optionally another embedding model. This gives you a realistic development environment close to how Curia is actually used.

### Nylas (Email)

Curia uses [Nylas](https://nylas.com) as its email layer. Nylas is a unified API that handles the IMAP/SMTP complexity and provides a consistent interface across Gmail, Outlook, and other providers.

**1. Create a Nylas account**

Sign up at [app.nylas.com](https://app.nylas.com). The free tier is sufficient for development.

**2. Create an application**

In the Nylas dashboard, create a new application. Choose "Email" as the product. Once created, copy your **API key**. This is your `NYLAS_API_KEY`.

**3. Connect Curia's mailbox**

In your application, go to **Grants** and add a new grant. This connects an email account (Gmail, Outlook, etc.) to your Nylas application via OAuth. Use the address you want Curia to read and send from.

After completing the OAuth flow, the grant appears in your dashboard. Copy the **Grant ID**.

> **Note:** For development, using a dedicated email account (rather than your primary inbox) is strongly recommended. Curia will read and process all incoming messages.

**4. Configure the channel in the console**

Open **Settings -> Channels -> Email** and:

1. **Install** the channel.
2. Save the **Nylas API key**. (Or seed it instead: `SEED_VAULT_ONLY=channel.email.nylas_api_key NYLAS_API_KEY=nyk_v0_... pnpm run seed-vault`.)
3. Under **Email accounts**, add Curia's mailbox: a short name (e.g. `curia`), its address, and the grant ID. The grant is stored in the vault at `channel.email.<name>.nylas_grant_id`.
4. **Enable** the channel. Enable stays disabled until the API key resolves and at least one enabled account has a grant.

Restart Curia (`pnpm local`). The email channel boots one adapter per enabled account; grants and addresses come only from the email accounts. See [configuration.md](configuration.md#email-accounts) for multiple accounts.

**5. Connect the principal's own mailbox (optional)**

Calendar and the `ceo-inbox` tools work in the principal's own mailbox, through a second Nylas grant. Connect that mailbox in Nylas the same way, then in **Settings -> Behaviour -> Email & Calendar** add it (a short id, a label and its grant ID). Add each of the principal's Gmail accounts the same way. No restart is needed. The page needs the email channel's Nylas API key from step 4; until it is saved, the page says so and adding is off. Until a mailbox is connected, calendar and the inbox tools answer that none is.

### Embeddings

An embedding model powers entity memory and semantic search in the knowledge graph. Curia
ships one: with no embedding variables set, it runs the bundled `all-MiniLM-L6-v2`
in-process, with no key and no network call ([ADR-065](../adr/065-bundled-in-process-embedding-model.md)).
A source run needs its weights (`pnpm fetch:embedder`, Tier 1). If entity memory is off,
the knowledge graph, the sensitivity classifier and the setup wizard are off with it, and
`/api/health` says why in `details.knowledge_graph`. The scenario suite (`pnpm scenarios`)
needs `openrouter_api_key` in the vault for its judge, and a working embedding source (see
[behavior-tests.md](behavior-tests.md) and `tests/scenarios/README.md`).

The bundled model is English-only. **To use another model, point Curia at an embedding
server.** Any server that speaks OpenAI's `/embeddings` API works (llama.cpp, Ollama, vLLM,
OpenAI), on the same machine or elsewhere. Curia sends every knowledge-graph label to this
server, sensitive facts included, so use HTTPS for a server on another machine. Set the
endpoint in `.env`, and seed its key only if the server checks one:

```bash
EMBEDDING_BASE_URL=http://localhost:8080/v1
EMBEDDING_MODEL=Qwen3-Embedding-4B
```

```bash
SEED_VAULT_ONLY=embedding_api_key EMBEDDING_API_KEY=... pnpm run seed-vault
```

For OpenAI, use `EMBEDDING_BASE_URL=https://api.openai.com/v1`,
`EMBEDDING_MODEL=text-embedding-3-small`, and the OpenAI key as `embedding_api_key`. A
database whose graph already holds `text-embedding-3-small` vectors keeps using OpenAI with
`openai_api_key` and no variables, but that path is deprecated (#2628); see
[configuration.md](configuration.md#embedding-source).

Set `EMBEDDING_MODEL` even when the server ignores the field, because Curia picks the profile by that name. The model needs a profile: `text-embedding-3-small`, `Qwen3-Embedding-4B` and `all-MiniLM-L6-v2` are built in, and [`embedding.profiles`](configuration.md#embeddingprofiles) adds others. Restart Curia after a change. On a fresh database the first boot sizes the vector column to the profile. To switch models later on a graph that already holds vectors, stop Curia and run `pnpm reembed:kg` once (ADR-051). To switch back to the bundled model, unset `EMBEDDING_BASE_URL` and set `EMBEDDING_MODEL=all-MiniLM-L6-v2` before re-embedding; the explicit name is the switch signal.

In a Docker Compose install, stop Curia and run the command in a one-off container:

```bash
docker compose run --rm curia ./node_modules/.bin/tsx scripts/reembed-kg.ts
```

An install with its own compose file or service name runs the command through that file and service.

The command refuses to run beside a live Curia, and names the process that holds the lock. An interrupted run stays recorded as open, and the knowledge graph stays off until you run the command again to finish it. `--force` re-embeds every row even when its stamp matches, for an endpoint that started serving other weights under the same model name (`weights_changed` or `weights_shifted` in health).

> **Checkpoint:** Email channel active, knowledge graph working with semantic search. This is the recommended baseline for most development work.

---

## Tier 3 - Full

Adds Signal messaging (when available).

### Signal

Signal messaging runs via [signal-cli](https://github.com/AsamK/signal-cli) in JSON-RPC daemon mode, over a Unix socket. The shipped `docker-compose.yml` does not include signal-cli, so you run it yourself and share its socket with Curia.

**1. Run signal-cli**

Register a phone number with signal-cli (`signal-cli register` + `verify`), then run it as a daemon listening on a Unix socket (`signal-cli daemon --socket <path>`). If Curia runs in Docker, mount the socket's directory into the `curia` container. Refer to your deployment documentation for the details.

**2. Configure the channel in the console**

Open **Settings -> Channels -> Signal**, install the channel, and save:

- **signal-cli socket path**: the socket's path as Curia sees it (inside the container, for a Docker install).
- **Phone number (E.164)**: the number you registered, e.g. `+12223334444`.

Both are required. Enable the channel and restart Curia.

---

## Optional: higher web search limits (Tavily key)

`web-search` works on a fresh install with no key. It enrolls with the default `web`
bundle and calls Tavily in **keyless mode** (the `X-Tavily-Access-Mode: keyless`
header): free, same results, but capped per server IP per hour. In a 2026-11-03 test
the 30th search in an hour got HTTP 429 (#2445). Tavily doesn't publish the limit.

When the cap is hit, `web-search` returns an error saying search is temporarily limited
and how to add a key, and agents relay it to the principal. A free Tavily key
(1,000 credits a month, no card) raises the limit. Add it any of these ways; each
takes effect on the next search, with no restart:

- **Console:** **Settings → Tools → web → Optional secrets → `tavily_api_key`**.
- **Chat:** ask Curia to "add my Tavily key". The setup assistant sends a one-time
  secure link that saves `tavily_api_key` straight to the vault.
- **Dev shortcut:** `TAVILY_API_KEY=tvly-... pnpm run seed-vault`.

With a key set, requests are authenticated with it and never marked keyless. A bad key
returns an "invalid key" error; there is no silent fallback to keyless. Before #2445 the
setup link saved the key as `user.tavily_api_key`, which web-search never read. Boot moves
such a key to `tavily_api_key` (copy, then delete the `user.*` entry), so the migrated
value survives restarts and is never copied back once removed (#2409). To fix a rejected
key, use Replace in the console. To go back to keyless, remove the key from
**Memory → Secrets** (see [Adding secrets after setup](#adding-secrets-after-setup)), and
make sure `TAVILY_API_KEY` is not set in the environment, which would keep supplying it.

`ctx.secret('tavily_api_key')` resolves vault-first with a `TAVILY_API_KEY` env-var fallback. In production the vault is the single source of truth. Do **not** leave `TAVILY_API_KEY` set in the deploy environment, since a lingering env var would mask whether the vault entry is actually being used.

> **Revocation caveat:** the runtime resolver falls back to the env var. So if `TAVILY_API_KEY` is still set, deleting `tavily_api_key` from the vault does not stop keyed searches. The skill keeps using the env var, and only the `secret.accessed` event (`source: env`) reveals it. Remove the env var before rotating or revoking the key through the vault.

## Audit log integrity check

Phase 1 hardening (spec 10 / #1383) maintains a SHA-256 hash chain on `audit_log`,
ordered by the monotonic `seq` column (not wall-clock timestamp). Phase 1 detects
accidental corruption and naive tampering — not a knowledgeable insider with DB
write access (HMAC + external anchoring are a later phase). Verify offline with:

```bash
# Local / developer DB
pnpm audit:verify

# Deployed instance (example path)
pnpm --prefix /opt/curia tsx --env-file=.env scripts/audit-verify.ts
```

Exits `0` when the chain is intact (or the log is empty / only unhashed rows),
`1` on the first broken link, and `2` on configuration/DB errors. Pre-hardening
rows with NULL `entry_hash` are skipped.

---

## What's Next

If you walked through Tier 1, you've already configured the office identity
and met the `setup-wizard` agent. From here:

- **Use the chat view.** Open `http://localhost:3000/chat` and start
  talking to the coordinator. This is the primary surface for everyday use.
- **Or use the CLI.** Run `pnpm local` in a terminal. It attaches a CLI
  channel to the running stack. Type a message at the prompt.

If you want to dig deeper, the [architecture overview](../specs/00-overview.md)
explains how the layers fit together, and the [agent](adding-an-agent.md)
and [skill](adding-a-tool.md) guides cover the most common extension points.
The end-to-end onboarding flow is documented in
[spec 18 - Onboarding](../specs/18-onboarding.md).

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

The channel needs the Nylas API key and at least one enabled email account with a grant (Tier 2, step 4). Check the boot log for:

- `NYLAS_API_KEY not set — email channel disabled`: save the API key under **Settings -> Channels -> Email**.
- `No email accounts resolved — email channel disabled. Add an account via the console (Settings → Channels → Email).`: add an account under **Email accounts**.
- `Email account has no nylas_grant_id in the vault — skipping (re-add the grant in the console)`: remove the account and add it again with its grant ID.
- `channel enabled but required credentials missing; not starting`: one of the above is missing although the channel is enabled.
