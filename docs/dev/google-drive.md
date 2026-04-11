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
4. Download the credentials JSON — you won't need the file, just the Client ID and Secret.

#### Step 4 — Set env vars

Add to `.env` (VPS and local):

```env
GOOGLE_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
```

#### Step 5 — Run the first OAuth flow (requires a browser)

The MCP server prints an auth URL on its first run. You must open it in a browser
signed in as Curia's Gmail.

**Option A (recommended): auth locally, copy tokens to VPS**

Use `--transport streamable-http` to run the server as an HTTP process so the
OAuth flow goes through the browser. Do NOT use the default stdio transport for
this step — stdio mode expects a JSON-RPC client on stdin, not a human, and will
log parse errors if run directly in a terminal (those errors are harmless but the
OAuth flow won't complete).

```bash
# Install uv locally if not already present
curl -LsSf https://astral.sh/uv/install.sh | sh

# Run the server in HTTP mode — this starts an OAuth callback listener
GOOGLE_OAUTH_CLIENT_ID=<...> GOOGLE_OAUTH_CLIENT_SECRET=<...> uvx workspace-mcp --transport streamable-http

# Open http://localhost:8000/mcp in a browser.
# You will be redirected to Google's OAuth consent page.
# (http://localhost:8000 is just a health check — use /mcp to trigger auth)
# Log in as Curia's Gmail (nathancuria1@gmail.com) and approve access.
# Tokens are saved to ~/.workspace-mcp/cli-tokens/ — you can then Ctrl-C the server.
```

Then copy the token cache to the VPS:

```bash
# Replace <vps-host> with your server (e.g. ceo-office)
scp -r ~/.workspace-mcp/cli-tokens <vps-host>:/tmp/cli-tokens

# On the VPS: copy into the Docker volume at the path the server expects.
# The volume is mounted at /root/.workspace-mcp; the server reads tokens from
# /root/.workspace-mcp/cli-tokens/, so files must land at _data/cli-tokens/.
ssh <vps-host> docker volume inspect curia_google_workspace_tokens
ssh <vps-host> "cp -r /tmp/cli-tokens /var/lib/docker/volumes/curia_google_workspace_tokens/_data/"
```

After copying, restart Curia and check the logs for:

```text
INFO  MCP server tools registered  {"server":"google-workspace","registered":N,"total":N}
```

**Option B: auth directly on the VPS** (requires X11 forwarding or port tunneling)

Not recommended for initial setup — Option A is simpler.

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
not been completed — the token cache at `/root/.workspace-mcp/cli-tokens/` is empty
or missing. Repeat Step 5.

**Tools disappear after container restart**

The `google_workspace_tokens` Docker volume is not being persisted. Confirm the volume
is declared in `docker-compose.yml` and mounted at `/root/.workspace-mcp`.

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
      - google_workspace_tokens:/root/.workspace-mcp
      # ... existing volumes ...

volumes:
  google_workspace_tokens:
  # ... existing volumes ...
```

> **TODO:** These `curia-deploy` changes are tracked as a follow-up. The community
> server will not start in production until they are applied.

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
5. Remove the `google_workspace_tokens` Docker volume (auth moves to the hosted side).

> **Note on token injection**: `skills.yaml` headers are literal strings — no
> env-var interpolation. Bearer tokens expire (~1 hour), so a static value isn't
> suitable for production. A `skills.yaml.template` + `envsubst` at startup is the
> recommended interim pattern. File a ticket when the hosted server ships to wire up
> token generation and injection alongside the config change.
