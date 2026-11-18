# Google Drive Setup

This guide covers Google Drive / Workspace integration via the community MCP server
(`taylorwilsdon/google_workspace_mcp`) and what changes when Google ships their
official hosted Workspace MCP server.

---

## Current approach (April 2026): community stdio server

Google's hosted Workspace MCP server is not yet available. In the meantime, Curia
uses [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
as a local stdio subprocess — the MCP loader spawns it via `scripts/workspace-mcp.sh`
and communicates over stdin/stdout. That launcher runs the version and dependency
tree locked in `scripts/workspace-mcp/requirements.txt` (#2010, #2657). The Docker
image installs that lockfile at build time, so the container never fetches anything
from PyPI. Anywhere else (`pnpm dev`, `scripts/gdrive-auth.py`), it runs through
`uvx`, constrained to the same lockfile. See
[Bumping workspace-mcp](#bumping-workspace-mcp).

This gives Curia access to Drive, Sheets and Docs using OAuth 2.0 as Curia's own
Gmail user. `config/skills.yaml` passes `--tools drive docs sheets`, and that
allowlist is the only thing deciding which services load (#1957), so keep it
exact: `tests/unit/config.google-workspace-allowlist.test.ts` fails on any change.

- **Calendar is never on it.** Principal calendar access goes through the
  Nylas-backed `calendar` skill; Workspace Calendar tools would authenticate as
  Curia's own identity and read an empty calendar (#1853).
- **Gmail is not on it.** Curia's email tools (the `email` bundle) cover the same
  mailbox, including whole-thread reads (`email-get-thread`).

### One-time setup

#### Step 1 — Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. `curia-workspace`).
   Use an admin/developer Google account — not Curia's Gmail account.
2. Enable these APIs (APIs & Services → Library):
   - Google Drive API
   - Google Sheets API
   - Google Docs API

   Do **not** enable Google Calendar API for Curia's Workspace OAuth client.
   Principal calendar traffic uses Nylas, and Calendar is not in `--tools`
   (#1853). Enabling it here only widens Curia's grant without a caller. The
   same goes for the Gmail API: Curia's email runs through Nylas.

#### Step 2 — OAuth consent screen

1. Go to APIs & Services → OAuth consent screen.
2. Choose **External** (works with any Gmail account, including Curia's).
3. Fill in the app name and contact email.
4. Add scopes: Drive, Sheets, Docs.
   Omit Calendar and Gmail — see Step 1.
5. Under **Test users**, add Curia's Gmail address (only needed until you publish the app, below).

> **Existing deployments:** narrowing `--tools` does not revoke anything already
> granted. Existing tokens keep working (upstream scope checks are
> superset-based), but scopes for services no longer loaded (Calendar, Gmail,
> and anything else an older allowlist had) stay live until you revoke the grant
> at [myaccount.google.com](https://myaccount.google.com/permissions) and re-run
> Step 5. Do this at the next convenient window; nothing breaks if you don't —
> there is simply no caller for those scopes (#1853, #1957).

> **Don't leave the app in "Testing".** Refresh tokens issued to a Testing app expire after
> 7 days, so Curia's Drive access would break weekly. Publish the app (Publish App button, status
> **In production**). Publishing does not list it publicly. It stays unverified, which is fine for
> an app with a handful of known users: you click through the "unverified app" screen once.
> An unverified production app kept a restricted scope working past 7 days in prod (2026-11-17).

#### Step 3 — Create OAuth credentials

1. APIs & Services → Credentials → Create Credentials → **OAuth client ID**.
2. Application type: **Desktop app**.
3. Name it (e.g. `curia-mcp-client`).
4. Note the **Client ID** and **Client Secret** — you will need these in the next step.

#### Step 4 — Seed the OAuth secrets into the vault

As of #913 the Google Workspace OAuth secrets live in the **encrypted vault**, not
in `.env`. Both consumers read them from the vault at runtime: the
`drive-download-file` skill (via `ctx.secret()`, audited) and the `google-workspace`
MCP subprocess (resolved at spawn time by the MCP loader, vault-only).

Seed all three on each environment (VPS and local) by setting them transiently and
running the seeder — the vault upsert is idempotent, so re-running is safe:

```bash
GOOGLE_OAUTH_CLIENT_ID=<your-client-id>.apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-... \
CURIA_GOOGLE_EMAIL=<curia-gmail> \
  pnpm run seed-vault
```

This writes the vault keys `google_oauth_client_id`, `google_oauth_client_secret`,
and `curia_google_email`. Do **not** add these to `.env` — if the vault has no row
for them, the `google-workspace` MCP server is skipped at startup and Drive download
fails with a clear "not set in the vault" error.

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
callback) with the same `--tools drive docs sheets` allowlist as runtime, opens your
browser once, and waits for you to complete the login. The allowlist is what keeps
Calendar and Gmail scopes out of the consent: workspace-mcp requests the scopes of
every service it has enabled.

Log in as **Curia's Gmail account**.

After all services in the auth script are authenticated (Drive, Sheets and Docs;
#1957), tokens are saved to:
```text
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
   It should list Drive, Sheets and Docs tools only — no Gmail or Calendar
   tools (#1957, #1853). The startup log line `Tool tier 'complete' loaded: N
   tools across 3 services [['docs', 'drive', 'sheets']]` confirms the same.

3. **End-to-end read**: share a test Google Sheet with Curia's Gmail, then ask:
   *"Read the test sheet and summarize what's in it."*

4. **End-to-end write**: ask Curia to add a row to the test sheet. Verify in Google Sheets.

---

### Troubleshooting

**`ERROR Failed to connect to MCP server`**

In the container, the server runs from its build-time install at
`/opt/uv/bin/workspace-mcp`, so no network is involved. Check it is there with
`docker compose exec curia test -x /opt/uv/bin/workspace-mcp && echo ok`. If it is
missing, the image predates #2010 or was built from a different Dockerfile; rebuild it.
(The compose-service form resolves the container regardless of project name.)

Under `pnpm dev`, the launcher needs `uvx` on the PATH (install `uv`, see Step 5),
and the first start downloads the pinned version.

**`ERROR MCP server advertises no tools`**

The server connected but advertised no tools. The loader logs
`MCP server advertises no tools — tools from this server will be unavailable until
restart` and stops there — the `INFO MCP server tools registered` success line is
never logged for that server. This usually means the OAuth flow has
not been completed — the token cache at `/home/curia/.google_workspace_mcp/credentials/`
(production image; `/tmp/.google_workspace_mcp/credentials/` in the vanilla image)
is empty or missing. Repeat Step 5.

**Tools disappear after container restart**

The `google_workspace_tokens` Docker volume is not being persisted. Confirm the volume
is declared in `docker-compose.yml` and mounted at `/tmp/.google_workspace_mcp`.
(Note: the production compose uses `google-workspace-tokens` with a hyphen — the name
differs between dev and production compose files.)

**Drive calls fail with 403 Forbidden**

The file or folder hasn't been shared with Curia's Gmail. Open Drive and share it
with Editor access.

**Drive calls fail with 401 Unauthorized**

OAuth token is invalid or expired. Revoke and re-grant access via Google account
security settings, then repeat Step 5.

---

## Bumping workspace-mcp

workspace-mcp and its whole dependency tree are pinned in two files in
`scripts/workspace-mcp/`, and nowhere else:

- `requirements.in` names the one direct requirement: workspace-mcp at an exact
  release.
- `requirements.txt` is compiled from it. It's the lockfile, with every package
  (fastmcp, mcp, the Google client libraries, ...) at an exact version, with hashes.
  The image installs it with `uv pip sync --require-hashes`, so a rebuild gets the
  same tree byte for byte, and a package missing from it fails the build.

workspace-mcp declares every dependency open-ended (`>=`), so without the lockfile
each rebuild would pick up whatever PyPI has that day, new majors included.

**Security fixes arrive as Dependabot PRs.** `.github/dependabot.yml` watches this
directory with the `uv` ecosystem, for security updates only. A PR for a vulnerable
package recompiles the lockfile with just that package upgraded (`uv pip compile -P
<package>`), and the dependabot merge agent handles it like any other bump. No
version updates are opened: the tree moves only for a CVE or a deliberate bump.

**To bump workspace-mcp itself,** or to refresh the whole tree on purpose:

1. Change the version in `requirements.in`.
2. Recompile from inside the directory, so the header records the command
   Dependabot replays:

   ```sh
   cd scripts/workspace-mcp
   uv pip compile --universal --python-version 3.13 --generate-hashes \
     requirements.in -o requirements.txt
   ```

   uv keeps every version already in `requirements.txt` that still satisfies the new
   release, and moves only what it must. Add `--upgrade` to refresh everything. Then
   read the diff for majors. `--python-version` is the image's Debian python3; change
   it only together with the image.
3. Build the image (`docker build .`). The build imports `main` and the module of
   each `--tools` service, so a broken dependency or a service that no longer
   loads fails here, not at boot. If the allowlist changes, update the import
   list in the `Dockerfile` and `SERVICE_MODULES` in
   `tests/unit/config.workspace-mcp-pin.test.ts`.
4. Start the server and compare its `tools/list` with the previous version's.
   Upstream renames and drops tools between releases, majors in particular.
   curia-deploy's `pnpm check-mcp-drift` does this against its snapshots.

---

## Production Dockerfile (`curia-deploy`)

The production image uses `curia-deploy/deploy/compose/Dockerfile.curia` (not the
`curia/Dockerfile`). It builds `FROM` the core image, so it inherits the
build-time `workspace-mcp` install at `/opt/uv/bin/workspace-mcp`.

Also add the token volume to `compose.production.yaml` under the `curia` service:

```yaml
services:
  curia:
    volumes:
      - google-workspace-tokens:/home/curia/.google_workspace_mcp
      # ... existing volumes ...

volumes:
  google-workspace-tokens:
  # ... existing volumes ...
```

---

## Future: Google-hosted Workspace MCP server

Google announced a hosted Workspace MCP server (Drive, Docs, Sheets, Gmail;
Calendar historically included upstream but Curia omits it — #1853)
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
