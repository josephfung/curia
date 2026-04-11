# Google Drive Setup

This guide documents the path to Google Drive integration via MCP and explains
what to do today versus what to do once Google ships their hosted Workspace MCP server.

---

## Current status (April 2026)

Google Drive is **not yet available** as an official Google-hosted MCP server.
Google announced Workspace MCP support (Drive, Docs, Sheets, Calendar, Gmail) in
late 2025 but has not shipped it as of April 2026. Track availability at:

> https://docs.cloud.google.com/mcp/supported-products

The previously referenced npm package (`@modelcontextprotocol/server-gdrive`) is
deprecated and marked "no longer supported" — do not use it.

---

## What's already wired

The Curia MCP infrastructure is fully ready for Google Drive the moment Google ships it:

- `config/skills.yaml` uses `transport: sse` which now routes through
  `StreamableHTTPClientTransport` — the same transport Google's hosted MCP servers use
- The `headers:` field in `skills.yaml` allows passing `Authorization: Bearer <token>`
  to any authenticated hosted MCP endpoint
- The coordinator's `allow_discovery: true` means Drive tools will be discoverable once
  registered, and you can pin specific tool names in `pinned_skills` for consistent access

No code changes will be needed. Setup is purely a configuration step.

---

## When Google ships the Workspace MCP server

### Step 1 — Confirm the endpoint URL

Check `https://docs.cloud.google.com/mcp/supported-products` for the official endpoint.
It will likely follow the pattern `https://workspaceapis.googleapis.com/mcp` or similar.

### Step 2 — Provision a service account and generate a bearer token

Google's hosted MCP servers authenticate via OAuth 2.0 bearer tokens. For unattended
server use, generate tokens from a service account:

**2a. Create a service account**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **IAM & Admin → Service Accounts**.
2. Click **Create Service Account**. Name it (e.g. `curia-drive`) and click **Create and continue**.
3. Grant it the minimum Drive scope needed (e.g. `roles/drive.file` to operate only on
   files created by the service account, or `roles/drive.readonly` for read-only access).
4. Click **Done**.

**2b. Create and download a key**

1. Click the service account → **Keys** tab → **Add key → Create new key → JSON**.
2. Move the downloaded file somewhere secure outside the repo
   (e.g. `~/.config/curia/gdrive-service-account.json`).
3. Add to `.env`:

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/gdrive-service-account.json
```

**2c. Generate a bearer token at startup**

`config/skills.yaml` headers are literal strings — no env-var interpolation is performed.
The recommended pattern is to generate a short-lived token before starting Curia and
inject it into the environment, then reference it via a startup wrapper script:

```bash
#!/usr/bin/env bash
# scripts/start-with-gdrive.sh — generate a Drive bearer token and start Curia.
# Requires: gcloud CLI authenticated as the service account, or ADC configured.
GOOGLE_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
export GOOGLE_ACCESS_TOKEN
# Note: you'll still need literal header values in skills.yaml.
# For now, write the token into a temp file that skills.yaml references,
# or run envsubst on a skills.yaml.template before startup.
pnpm local
```

> **Roadmap:** Env-var interpolation in `skills.yaml` header values (analogous to
> `env:VAR_NAME` in `config/default.yaml`) is a natural follow-up. File a ticket when
> the Workspace MCP server ships so this can be added alongside the Drive config.

### Step 3 — Update `config/skills.yaml`

Uncomment and fill in the template (already present in the file):

```yaml
servers:
  - name: google-workspace
    transport: sse
    url: https://workspaceapis.googleapis.com/mcp   # confirm at launch
    action_risk: low
    headers:
      Authorization: "Bearer <your-token>"          # inject at startup; see above
```

### Step 4 — Pin tools in `agents/coordinator.yaml`

After startup, check the logs for lines like:

```
INFO  MCP tool registered  {"server":"google-workspace","tool":"drive.files.list"}
INFO  MCP server tools registered  {"server":"google-workspace","registered":N,"total":N}
```

Add the tool names you want the coordinator to use by default to `pinned_skills` in
`agents/coordinator.yaml`:

```yaml
pinned_skills:
  # ... existing skills ...
  - drive.files.list
  - drive.files.get
  - drive.files.create
```

Restart Curia after any `coordinator.yaml` change.

### Step 5 — Share the target Drive folder

Create or designate a root folder in Drive for Curia's use. Share it with the service
account's email address (found on the service account detail page, looks like
`curia-drive@your-project.iam.gserviceaccount.com`) with **Editor** access.

The service account can only access content explicitly shared with it — there's no need
for code-level path restrictions.

### Step 6 — Smoke test

Ask Curia to list or search Drive files:

> "Search Drive for our expense tracker and summarize the last few entries."

Check the startup logs if tools don't respond — a connection failure produces:

```
ERROR  Failed to connect to MCP server — tools from this server will be unavailable until restart
```

---

## Troubleshooting

**`ERROR Failed to connect to MCP server`**

Connection to the Google endpoint failed. Check:
- The URL in `skills.yaml` is correct and the endpoint is live
- The bearer token is valid and not expired (tokens typically last 1 hour)

**Drive calls fail with 401 Unauthorized**

The token is missing, expired, or has insufficient scope. Regenerate via
`gcloud auth application-default print-access-token` and restart.

**Drive calls fail with 403 Forbidden**

The service account doesn't have access to the target file or folder. Confirm the
service account email has been shared on the folder with at least Viewer (read) or
Editor (write) access.

**Tools not appearing in coordinator**

Tool names in `pinned_skills` must exactly match what the server advertises via
`tools/list`. Check startup logs for the registered names and update `coordinator.yaml`
to match, then restart.
