# Google Drive Setup

This guide covers Google Drive / Workspace integration via the community MCP server
(`taylorwilsdon/google_workspace_mcp`) and what changes when Google ships their
official hosted Workspace MCP server.

---

## Current approach (April 2026): community stdio server

Google's hosted Workspace MCP server is not yet available. In the meantime, Curia
uses [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
as a local stdio subprocess — the MCP loader spawns it via `uvx workspace-mcp` and
communicates over stdin/stdout.

This gives Curia full access to Drive, Sheets, Docs, Gmail, Calendar, and more using
OAuth 2.0 as Curia's own Gmail user.

### One-time setup

#### Step 1 — Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. `curia-workspace`).
   Use an admin/developer Google account — not Curia's Gmail account.
2. Enable these APIs (APIs & Services → Library):
   - Google Drive API
   - Google Sheets API
   - Google Docs API
   - Gmail API
   - Google Calendar API

#### Step 2 — OAuth consent screen

1. Go to APIs & Services → OAuth consent screen.
2. Choose **External** (works with any Gmail account, including Curia's).
3. Fill in the app name and contact email.
4. Add scopes: Drive, Sheets, Docs, Gmail, Calendar.
5. Under **Test users**, add Curia's Gmail address.

> The app can stay in "Testing" mode. If you want non-expiring tokens without having
> to re-add test users, publish the app (Publish App button). Publishing does not make
> the app publicly listed — it just removes the 7-day test-token expiry.

#### Step 3 — Create OAuth credentials

1. APIs & Services → Credentials → Create Credentials → **OAuth client ID**.
2. Application type: **Desktop app**.
3. Name it (e.g. `curia-mcp-client`).
4. Note the **Client ID** and **Client Secret** — you will need these in the next step.

#### Step 4 — Set env vars

Add to `.env` (VPS and local):

```env
GOOGLE_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
```

#### Step 5 — Run the first OAuth flow

The OAuth flow must be completed locally (where you have a browser) and the resulting
token cache copied to the VPS. There is no browser-accessible auth URL — authentication
is initiated programmatically via the `start_google_auth` MCP tool.

A script at `scripts/gdrive-auth.py` handles the full flow.

**Prerequisites:**
- `uv` installed locally (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

**Run the script:**

```bash
GOOGLE_OAUTH_CLIENT_ID=<...> GOOGLE_OAUTH_CLIENT_SECRET=<...> CURIA_GOOGLE_EMAIL=<curia-gmail> \
  uv run --with mcp scripts/gdrive-auth.py
```

The script connects to a single persistent `workspace-mcp` process (important — each
service auth call must happen in the same process so the OAuth state survives the
callback), opens your browser once per service, and waits for you to complete the login.

Log in as **Curia's Gmail account** each time.

After all five services are authenticated, tokens are saved to:
```
~/.google_workspace_mcp/credentials/<curia-gmail>.json
```

**Copy tokens to the VPS:**

```bash
scp -P 2222 -r ~/.google_workspace_mcp/credentials ceo-office:/tmp/google_workspace_credentials
ssh -p 2222 ceo-office "sudo cp -r /tmp/google_workspace_credentials /var/lib/docker/volumes/curia_google-workspace-tokens/_data/credentials"
```

After copying, restart Curia and check the logs for:

```text
INFO  MCP server tools registered  {"server":"google-workspace","registered":N,"total":N}
```

A non-zero `registered` count confirms the server connected and auth is working.

#### Step 6 — Share Drive content with Curia

There's nothing to configure in code. Just use the normal Google Drive UI:

1. Open the Google Sheet or Drive folder you want Curia to access.
2. Share it with Curia's Gmail address, granting **Editor** access.

Curia will be able to read and write anything shared with that Gmail.

---

### Token refresh and rotation

OAuth tokens auto-refresh in the background — no manual action needed for day-to-day use.

If tokens are ever revoked (e.g. you revoke app access in Google account security settings),
repeat Step 5 to re-authenticate and copy fresh tokens to the VPS.

---

### Verification

1. **Startup log**: after Curia boots, look for:
   ```text
   INFO  MCP server tools registered  {"server":"google-workspace","registered":N}
   ```
   A non-zero `registered` count means the server connected and tools are available.

2. **Tool discovery**: ask Curia: *"What Google Workspace tools do you have available?"*
   It should list Drive, Sheets, Docs, Gmail, and Calendar tools.

3. **End-to-end read**: share a test Google Sheet with Curia's Gmail, then ask:
   *"Read the test sheet and summarize what's in it."*

4. **End-to-end write**: ask Curia to add a row to the test sheet. Verify in Google Sheets.

---

### Troubleshooting

**`ERROR Failed to connect to MCP server`**

`uvx` is not on the PATH inside the container. The Dockerfile installs `uv`/`uvx` into
`/usr/local/bin/` via `COPY --from=ghcr.io/astral-sh/uv`. Verify with
`docker exec curia which uvx` — if missing, rebuild the image.

**`INFO MCP server tools registered {"registered":0}`**

The server connected but advertised no tools. This usually means the OAuth flow has
not been completed — the token cache at `/root/.google_workspace_mcp/credentials/` is
empty or missing. Repeat Step 5.

**Tools disappear after container restart**

The `google-workspace-tokens` Docker volume is not being persisted. Confirm the volume
is declared in `docker-compose.yml` and mounted at `/root/.google_workspace_mcp`.

**Drive calls fail with 403 Forbidden**

The file or folder hasn't been shared with Curia's Gmail. Open Drive and share it
with Editor access.

**Drive calls fail with 401 Unauthorized**

OAuth token is invalid or expired. Revoke and re-grant access via Google account
security settings, then repeat Step 5.

---

## Production Dockerfile (`curia-deploy`)

The production image uses `curia-deploy/deploy/compose/Dockerfile.curia` (not the
`curia/Dockerfile`). That file also needs `uv`/`uvx`. Use the same signed,
version-pinned copy pattern as `curia/Dockerfile`:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /uvx /usr/local/bin/
```

Also add the token volume to `compose.production.yaml` under the `curia` service:

```yaml
services:
  curia:
    volumes:
      - google-workspace-tokens:/root/.google_workspace_mcp
      # ... existing volumes ...

volumes:
  google-workspace-tokens:
  # ... existing volumes ...
```

---

## Future: Google-hosted Workspace MCP server

Google announced a hosted Workspace MCP server (Drive, Docs, Sheets, Calendar, Gmail)
in late 2025. Track availability at:

> https://docs.cloud.google.com/mcp/supported-products

When it ships, the migration path is:

1. Confirm the endpoint URL (likely `https://workspaceapis.googleapis.com/mcp`).
2. Generate a bearer token (OAuth 2.0 via service account or user delegation).
3. In `config/skills.yaml`, replace the current `stdio` entry with:
   ```yaml
   - name: google-workspace
     transport: sse
     url: https://workspaceapis.googleapis.com/mcp
     action_risk: low
     headers:
       Authorization: "Bearer <token>"
   ```
4. Remove the `uv` install from the Dockerfile (no longer needed).
5. Remove the `google-workspace-tokens` Docker volume (auth moves to the hosted side).

> **Note on token injection**: `skills.yaml` headers are literal strings — no
> env-var interpolation. Bearer tokens expire (~1 hour), so a static value isn't
> suitable for production. A `skills.yaml.template` + `envsubst` at startup is the
> recommended interim pattern. File a ticket when the hosted server ships to wire up
> token generation and injection alongside the config change.
