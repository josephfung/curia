# Google Drive Setup

This guide wires Curia to a designated Google Drive folder via the
`@modelcontextprotocol/server-gdrive` MCP server. Once configured, Curia can
search, read, and create documents and spreadsheets in that folder —
enabling persistent structured content like expense trackers and job
application trackers.

The integration uses a **Google service account** (not personal OAuth) so
no browser-based consent flow is required. You share a specific Drive folder
with the service account; Curia operates only within that scope.

---

## Prerequisites

- A Google Cloud project (or access to create one)
- A Google Drive folder you control (or can create)
- `GOOGLE_APPLICATION_CREDENTIALS` added to your `.env`

---

## Step 1 — Create a Google Cloud project

Skip this step if you already have a project to use.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. In the top bar, click the project selector → **New Project**.
3. Give it a name (e.g. `curia-integrations`) and click **Create**.

---

## Step 2 — Enable the Google Drive API

1. In the Cloud Console, open **APIs & Services → Library**.
2. Search for **Google Drive API** and click it.
3. Click **Enable**.

---

## Step 3 — Create a service account

1. In the Cloud Console, open **APIs & Services → Credentials**.
2. Click **Create Credentials → Service account**.
3. Fill in a name (e.g. `curia-drive`) and description, then click **Create and continue**.
4. The role step is optional — skip it and click **Continue**, then **Done**.

---

## Step 4 — Create and download a service account key

1. On the **Credentials** page, click the service account you just created.
2. Go to the **Keys** tab.
3. Click **Add key → Create new key**.
4. Choose **JSON** and click **Create**. A `.json` file downloads automatically.
5. Move it to a secure location outside the repo (e.g. `~/.config/curia/gdrive-service-account.json`).

> **Security:** Never commit this file or its contents to version control.
> The key grants full Drive API access as the service account.

---

## Step 5 — Set the credential path in `.env`

Add the absolute path to your service account JSON file:

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/gdrive-service-account.json
```

The MCP server process inherits all of `process.env` at startup, so the
`googleapis` library picks this up automatically via application-default
credentials. No `env:` block is needed in `config/skills.yaml`.

---

## Step 6 — Share a Drive folder with the service account

Curia's scope is determined entirely by which folders the service account
can see — there is no code-level path restriction. Share exactly what you
want Curia to access and nothing more.

1. In Google Drive, navigate to (or create) the root folder for Curia —
   e.g. `Curia Working Files`.
2. Right-click the folder → **Share**.
3. In the **Add people and groups** field, paste the service account's email
   address. You'll find it on the service account detail page in the Cloud
   Console — it looks like `curia-drive@your-project.iam.gserviceaccount.com`.
4. Set the role to **Editor** (so Curia can both read and create files).
5. Uncheck **Notify people** and click **Share**.

> The service account does not receive notifications and has no Drive UI.
> The share is immediate.

---

## Step 7 — Verify `config/skills.yaml`

Confirm the gdrive entry is present (it ships with the repo):

```yaml
servers:
  - name: gdrive
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-gdrive"]
    action_risk: low
    sensitivity: normal
    timeout_ms: 30000
```

No changes needed here — `GOOGLE_APPLICATION_CREDENTIALS` is inherited from
the environment, not declared in the `env:` block.

---

## Step 8 — Confirm tool names and update `pinned_skills`

The MCP server advertises its tool names at startup. The coordinator's
`agents/coordinator.yaml` ships with best-effort names (`search`,
`read_file`) based on the package source, but these may differ across
versions. Confirm the actual names before going to production.

**Start Curia and check the startup logs:**

```bash
pnpm local
```

Look for lines like:

```
INFO  MCP tool registered  {"server":"gdrive","tool":"search"}
INFO  MCP tool registered  {"server":"gdrive","tool":"read_file"}
INFO  MCP server tools registered  {"server":"gdrive","registered":2,"total":2}
```

If the tool names in the logs differ from what's in `pinned_skills`, update
`agents/coordinator.yaml` to match:

```yaml
pinned_skills:
  # ... existing skills ...
  # Replace with actual names from tools/list:
  - search
  - read_file
```

Restart Curia after any `coordinator.yaml` change.

---

## Step 9 — Smoke test

Ask Curia something that requires a Drive lookup. For example:

> "Search Drive for our expense tracker and summarize the last few entries."

If the integration is working, Curia calls the `search` tool and returns
content from your shared folder. If Drive isn't responding, check the logs
for `MCP server tools registered` — a connection failure at startup produces
an `ERROR Failed to connect to MCP server` log entry and the tools will be
unavailable until restart.

---

## Troubleshooting

**`ERROR Failed to connect to MCP server`**

The MCP server process failed to start. Common causes:

- `npx` not in `PATH` — confirm `which npx` works in the terminal where
  Curia runs.
- Network issue downloading the package — `npx -y @modelcontextprotocol/server-gdrive`
  downloads on first run. Check connectivity.

**Drive calls fail with "insufficient permissions"**

The service account lacks access to the target folder. Confirm the service
account email is listed as Editor on the folder (Step 6). Changes take
effect immediately — no restart needed on the Drive side.

**Drive calls fail with "invalid_grant" or "could not refresh access token"**

The service account key file is missing, corrupt, or at the wrong path.
Confirm:

```bash
echo $GOOGLE_APPLICATION_CREDENTIALS  # should print the path
cat $GOOGLE_APPLICATION_CREDENTIALS   # should print valid JSON
```

**Tools not showing in coordinator**

If tool names in the startup logs don't match `pinned_skills` in
`coordinator.yaml`, the LLM won't see the tools. Update `pinned_skills` to
match the logged names (Step 8) and restart.
