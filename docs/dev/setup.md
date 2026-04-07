# Development Setup

This guide gets your local Curia instance running. Setup is organized into three tiers — start with the minimum and add services as needed.

| Tier | Services | What you get |
|---|---|---|
| **1 — Minimum** | Anthropic + Postgres | Agents running, CLI and web app working |
| **2 — Recommended** | + Nylas + OpenAI | Email channel active, entity memory and semantic search working |
| **3 — Full** | + Tavily (+ Signal, coming soon) | Web research skill, encrypted Signal messaging |

Complete each tier before moving to the next.

---

## Prerequisites

Install these before anything else:

- **Node.js 22+** — check with `node --version`
- **Docker and Docker Compose** — Postgres runs in Docker; install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or the standalone CLI
- **pnpm** — `npm install -g pnpm`

---

## Tier 1 — Minimum

Everything you need to run Curia and interact with it via the CLI and web app.

### 1. Clone and install

```bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in these values. The rest can stay as-is for now.

**Postgres** — the database credentials for the Docker Compose container. You can use any values you like; they just need to match:

```env
DB_USER=curia
DB_PASSWORD=curia
DATABASE_URL=postgres://curia:curia@localhost:5432/curia
```

**Anthropic** — your API key from [console.anthropic.com](https://console.anthropic.com). Powers all agents.

```env
ANTHROPIC_API_KEY=sk-ant-...
```

**HTTP API token** — a secret for authenticating API requests. Generate any random string:

```env
API_TOKEN=your-secret-token-here
```

**Web app** — required to access the web app at `http://localhost:3000`. Generate any long random string:

```env
WEB_APP_BOOTSTRAP_SECRET=replace-with-a-long-random-secret
```

**Your email and timezone** — the CEO's primary email (prevents your first message from being held as an unknown sender) and IANA timezone for resolving relative dates in agent prompts:

```env
CEO_PRIMARY_EMAIL=you@yourdomain.com
TIMEZONE=America/Toronto
```

### 3. Start Postgres

```bash
docker compose up -d
```

This starts the Postgres container with pgvector and pgAudit. The first run pulls the image; subsequent starts are fast. Confirm it's healthy:

```bash
docker compose ps
```

### 4. Start Curia

```bash
pnpm local
```

On first run this applies all database migrations, then starts the full stack. You should see log output as the bus, agents, and channels initialize.

### 5. Verify

**CLI:** In a second terminal, you can interact with Curia directly:

```bash
pnpm local
# Once running, type a message into the CLI prompt
```

**Web app:** Open `http://localhost:3000` in your browser. You'll be prompted for your `WEB_APP_BOOTSTRAP_SECRET`. Once authenticated, the knowledge graph browser is available.

> **Checkpoint:** Curia is running. Agents work, the CLI is live, and the web app is accessible. Stop here or continue to Tier 2 for email and embeddings.

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

```env
NYLAS_API_KEY=nyk_v0_...
NYLAS_GRANT_ID=<grant-id-from-dashboard>
NYLAS_SELF_EMAIL=curia@yourdomain.com
```

Restart Curia (`pnpm local`) — the email channel activates automatically when all three Nylas vars are present.

### OpenAI (Embeddings)

OpenAI's embedding model (`text-embedding-3-small`) powers entity memory and semantic search in the knowledge graph. Without it, KG lookups are exact-match only and smoke tests are unavailable.

Get an API key from [platform.openai.com](https://platform.openai.com) and set it:

```env
OPENAI_API_KEY=sk-...
```

> **Checkpoint:** Email channel active, knowledge graph fully functional with semantic search. This is the recommended baseline for most development work.

---

## Tier 3 — Full

Adds web research capability and (when available) Signal messaging.

### Tavily (Web Search)

Powers the `web-search` skill, which lets agents research topics and look up current information.

Sign up at [tavily.com](https://tavily.com) and copy your API key:

```env
TAVILY_API_KEY=tvly-...
```

No restart required if Curia is already running — the skill picks up the key on next use.

### Signal

Signal messaging runs via [signal-cli](https://github.com/AsamK/signal-cli), which handles registration and acts as a daemon that Curia connects to over a Unix socket.

**1. Install signal-cli**

On macOS:
```bash
brew install signal-cli
```

On Linux, download the latest release from the [signal-cli releases page](https://github.com/AsamK/signal-cli/releases) and ensure it's on your `PATH`.

**2. Register a phone number**

You'll need a phone number that is not already registered with Signal on a mobile device — either a fresh SIM or a VoIP number (e.g. from Google Voice).

```bash
signal-cli -a +1XXXXXXXXXX register
# Enter the SMS verification code you receive:
signal-cli -a +1XXXXXXXXXX verify <code>
```

Alternatively, you can link signal-cli as a secondary device to an existing Signal account:
```bash
signal-cli link -n "Curia Dev"
# Scan the QR code printed to the terminal with your Signal mobile app
```

**3. Start signal-cli as a daemon**

Curia connects to signal-cli over a JSON-RPC Unix socket. Start the daemon before starting Curia:

```bash
signal-cli -a +1XXXXXXXXXX daemon --socket /tmp/signal.sock
```

Keep this running in a separate terminal (or run it as a background service).

**4. Set the env vars**

```env
SIGNAL_SOCKET_PATH=/tmp/signal.sock
SIGNAL_PHONE_NUMBER=+1XXXXXXXXXX
```

Restart Curia — the Signal channel activates when both vars are present. You can verify by checking startup logs for the absence of `SIGNAL_SOCKET_PATH/SIGNAL_PHONE_NUMBER not set — Signal channel disabled`.

---

## What's Next

With Curia running, the first thing to do is give it an identity. Open the web app at `http://localhost:3000`, enter your `WEB_APP_BOOTSTRAP_SECRET`, and go through the setup wizard — it walks you through naming your instance, setting its persona and voice, and configuring the CEO profile it operates on behalf of. This takes a few minutes and makes every subsequent interaction significantly more useful.

Once that's done, start a conversation. The CLI is the fastest way in:

```bash
pnpm local
```

Type a message at the prompt. You're talking to Curia.

If you want to dig deeper, the [architecture overview](../specs/00-overview.md) explains how the layers fit together, and the [agent](adding-an-agent.md) and [skill](adding-a-skill.md) guides cover the most common extension points.

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

All three Nylas vars (`NYLAS_API_KEY`, `NYLAS_GRANT_ID`, `NYLAS_SELF_EMAIL`) must be set. If any are missing, the channel silently disables itself at startup — check the startup logs for `NYLAS_API_KEY/NYLAS_GRANT_ID not set — email channel disabled`.
