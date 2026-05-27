# Design: Single-Command Setup via `pnpm setup`

**Issue:** #755  
**Date:** 2026-05-27  
**Status:** Approved

---

## Goal

Reduce the post-clone setup to a single command:

```bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm setup
```

After which Curia is running in Docker, the bootstrap secret is printed, and the user can log in immediately at `http://localhost:3000`.

---

## Approach

**Option A — host-side migrations.** The setup script starts only the Postgres container first, waits for it to be healthy, then runs `pnpm run migrate` from the host against `localhost:5432` (port is mapped by Docker). Once migrations succeed, the full stack starts.

This approach requires Node >= 22 and pnpm on the host — both already enforced by `package.json` and required to invoke `pnpm setup` in the first place. No changes to `docker-compose.yml` or the production Dockerfile.

---

## Script Flow — `scripts/setup.sh`

### 1. Prerequisite checks

Verify all four are present and runnable. Fail immediately on the first missing one with a one-line message and install link:

| Tool | Check | Install link |
|------|-------|-------------|
| `docker` | `docker info` exits 0 | https://docs.docker.com/get-docker/ |
| `docker compose` | `docker compose version` exits 0 | (bundled with Docker Desktop) |
| `node` | `node --version` >= 22 | https://nodejs.org/ |
| `pnpm` | `pnpm --version` exits 0 | https://pnpm.io/installation |

### 2. Idempotency — `.env` already exists

Present an interactive menu:

```
Your .env already exists. Looks like you've been here before.

  1  Start the stack      → docker compose up -d            (default)
  2  Resume setup         → re-run infra with existing .env
  3  Full reset           → ⚠  regenerates secrets, invalidates active sessions

Choice [1]:
```

- **Option 1 (default):** runs `docker compose up -d` and exits. Also prints a reminder of the underlying command so the user learns it.
- **Option 2:** skips secret generation (steps 3–5) and jumps directly to step 6 (start Postgres). Used for partial-failure recovery. If `# SETUP_COMPLETE` is absent from `.env`, the menu highlights option 2 with a note: "If setup didn't finish last time, choose 2."
- **Option 3:** warns that all active sessions will be invalidated, confirms before proceeding, then runs the full flow from scratch.

### 3. Secret generation

Generate cryptographically random secrets using `openssl rand -hex 32`:

| Variable | Value |
|----------|-------|
| `DB_USER` | `curia` (fixed) |
| `DB_PASSWORD` | `openssl rand -hex 32` |
| `API_TOKEN` | `openssl rand -hex 32` |
| `WEB_APP_BOOTSTRAP_SECRET` | `openssl rand -hex 32` |
| `DATABASE_URL` | `postgres://curia:${DB_PASSWORD}@localhost:5432/curia` |

### 4. Anthropic API key prompt

Only when writing a fresh `.env`. Print the console URL before asking:

```
Curia needs an Anthropic API key to run its agents.
Get one at: https://console.anthropic.com

Paste your key:
```

Validate that the key matches `sk-ant-[A-Za-z0-9_-]+`. Retry loop, max 3 attempts, with a clear error on bad format and the remaining attempt count. Exit with a message pointing to the console URL if all attempts fail.

### 5. Write `.env`

Template from `.env.example`, substituting the generated and collected values. Optional channel vars (Nylas, Signal, OpenAI, etc.) remain commented exactly as they are in `.env.example`.

### 6. Start Postgres

```bash
docker compose up -d postgres
```

### 7. Wait for Postgres health

Poll every 2 seconds, up to 60 seconds, printing elapsed time each tick:

```
==> Waiting for Postgres to be ready...
   ... still waiting (2s)
   ... still waiting (4s)
✓  Postgres is ready
```

On timeout, exit with:
```
✗  Postgres did not become healthy within 60s.
   Check logs: docker compose logs postgres
```

### 8. Install dependencies (if needed)

If `node_modules/` is absent (fresh clone), run:
```bash
pnpm install --frozen-lockfile
```

### 9. Run migrations

```bash
pnpm run migrate
```

On failure, exit with:
```
✗  Migrations failed. See the output above.
   To retry: pnpm setup  (choose option 2 — Resume setup)
```

### 10. Start the full stack

```bash
docker compose up -d
```

Postgres is already running; this starts the `curia` service.

### 11. Write completion marker

Append `# SETUP_COMPLETE` to `.env`. This marker is used by the idempotency check (step 2) to distinguish "setup finished cleanly" from "setup was interrupted partway."

### 12. Print summary box

```
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   Curia is running.                                    ║
║                                                        ║
║   Open:    http://localhost:3000                       ║
║                                                        ║
║   Bootstrap secret (save this to a password manager):  ║
║   <WEB_APP_BOOTSTRAP_SECRET>                           ║
║                                                        ║
║   Enter it on the login page to create your account.   ║
║   You won't be shown it again here.                    ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
```

The secret is the plain hex string — no grouping or hyphens (must be copy-pasteable).

---

## Console UX

**Color and icon system** (ANSI codes):
- `==>` section headers — bold
- `✓` — green for success
- `⚠` — yellow for warnings
- `✗` — red for errors
- Supplementary hints (log commands, etc.) — muted/grey

**Tone:** Direct and calm. Errors explain what went wrong and what to do next — no cryptic codes. The final box feels like a quiet "you're good to go," not a celebration.

---

## Files Touched

| File | Change |
|------|--------|
| `scripts/setup.sh` | New file — the setup script |
| `package.json` | Add `"setup": "bash scripts/setup.sh"` to `scripts` |
| `.env.example` | `DB_USER=your-db-user` → `DB_USER=curia`; clarify `DATABASE_URL` comment |
| `README.md` | Replace stale Quick Start block with new Quickstart section |

### README Quickstart section

Replace the current Quick Start block (which references `npm install` and a stale `db:migrate` command) with:

```markdown
## Quickstart

\`\`\`bash
git clone https://github.com/josephfung/curia.git
cd curia
pnpm setup
\`\`\`

Curia will be running at `http://localhost:3000`. The setup script prints your
bootstrap secret — save it to a password manager and use it on the login page
to create your account.

**[→ Full installation guide](https://docs.meetcuria.com/get-started/installation)**
(channels, production deploy, configuration reference)
```

---

## Error Handling Summary

| Failure point | Behaviour |
|---------------|-----------|
| Missing prerequisite | Exit 1 with name + install link; no side effects |
| Bad Anthropic key format | Retry up to 3 times; exit with console URL hint |
| `.env` write failure | Exit 1; nothing started yet |
| Postgres health timeout | Exit 1 with `docker compose logs postgres` hint |
| Migration failure | Exit 1 with "run `pnpm setup`, choose option 2" hint |
| `docker compose up` failure | Exit 1 with logs command |

---

## Out of Scope

- In-app onboarding wizard (covered by #486)
- Windows-native support (WSL works)
- Updating `docs.meetcuria.com` (tracked in `curia-docs`)
- Demo mode / hosted demo

---

## Acceptance Criteria

- [ ] `pnpm setup` runs end-to-end on a fresh clone with no existing `.env`
- [ ] If `.env` already exists, the script presents the menu — does not clobber the file
- [ ] Script fails fast with a clear error if `docker`, `docker compose`, `node`, or `pnpm` is unavailable
- [ ] All secrets use `openssl rand -hex 32`
- [ ] Anthropic API key validated for `sk-ant-...` format before writing
- [ ] After successful setup, `docker compose ps` shows `postgres` and `curia` both running and healthy
- [ ] Migrations apply successfully against the fresh Postgres instance
- [ ] `WEB_APP_BOOTSTRAP_SECRET` printed as plain hex (no grouping) in the summary box
- [ ] `# SETUP_COMPLETE` marker written to `.env` on success
- [ ] README Quickstart reflects the new flow
- [ ] Running `pnpm setup` again on an already-set-up checkout shows the menu and is safe
