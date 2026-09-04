# AGENTS.md

Project-wide engineering conventions live in `CLAUDE.md` (architecture, code style,
migrations, release process). Read that first. This file adds environment/run notes.

## Cursor Cloud specific instructions

These notes are for cloud agents working in an already-provisioned VM (the startup
update script has already run `pnpm install`). They capture non-obvious setup/run
caveats; standard commands live in `package.json` scripts and `scripts/setup.sh`.

### Toolchain
- **Node 24** is the target (`.nvmrc` = 24, `engines.node` >= 24). The VM's default
  system `node` (at `/exec-daemon`) is v22; Node 24 is installed via nvm and prepended
  to `PATH` in `~/.bashrc`, so `node`/`pnpm` already resolve to v24 + pnpm 11.7.0
  (corepack). Confirm with `node --version` if something looks off.
- Package manager is **pnpm** (workspace with `apps/console`). Use `pnpm`, never npm/yarn.

### Postgres (required for running the app and integration tests)
- Postgres 16 + pgvector + pgAudit runs via Docker Compose (`docker/postgres.Dockerfile`).
- **Docker is not auto-started** (no systemd in the VM) and **docker needs `sudo`**
  (the `ubuntu` user is not in the `docker` group). Start the daemon once per session:
  `sudo dockerd > /tmp/dockerd.log 2>&1 &` (a tmux session works well), then
  `sudo docker compose up -d postgres`. Wait for the container to be `healthy`.
- Host-side tools (`pnpm migrate`, `pnpm dev`) connect via `DATABASE_URL` in `.env`
  (localhost:5432). Inside the `curia` container the URL is overridden to use the
  `postgres` service name.

### Secrets / `.env` / vault (why the app may refuse to boot)
- `.env` holds only the values needed to *unlock* the vault: `DB_USER`, `DB_PASSWORD`,
  `DATABASE_URL`, `SECRET_ENCRYPTION_KEY` (+ optional `HTTP_PORT`, `TIMEZONE`, `LOG_LEVEL`).
  `pnpm run setup` generates it interactively; for non-interactive setup, template it
  from `.env.example` and fill those four values (see `scripts/setup.sh`).
- All API keys live in an **encrypted vault** (Postgres `secrets` table), NOT in `.env`.
  Seed them after migrations with `pnpm run seed-vault` (reads UPPER_SNAKE env vars).
- The app **fails to boot** unless three secrets are present in the vault:
  `anthropic_api_key`, `api_token`, `web_app_bootstrap_secret` (see `src/index.ts`
  boot guards and `scripts/seed-vault.ts`). The boot guard only checks they are
  non-empty, so a **placeholder `ANTHROPIC_API_KEY` lets the app boot and the web
  console / onboarding work, but any agent/LLM call (chat, the wizard's
  `suggest-name`) returns `401 invalid x-api-key`.** A real Anthropic key is required
  to exercise agents end to end.

### Running in development
- `pnpm dev` runs migrations (`predev`) then, via `concurrently`, the backend
  (`tsx watch`, HTTP API on **:3000**) and the console Vite dev server on **:5173**
  (Vite proxies `/api` and `/auth` to :3000). The backend also serves the built
  console from `apps/console/dist` at :3000 if that build exists.
- **Backend logs go to `curia.log`** (pino), not the `pnpm dev` stdout — tail that file
  to see backend errors. `GET /api/health` is the readiness check.
- Login: enter the `web_app_bootstrap_secret` value as the "Access key" on the login
  page (`POST /auth` sets a session cookie).
- First-run **onboarding wizard** shows until a principal exists AND the office identity
  has been saved (an `office_identity_versions` row with `changed_by` in
  `wizard`/`api`). The wizard's final step calls `POST /api/setup/restart`, which
  exits the process expecting a supervisor (Docker) to restart it — there is **no
  supervisor in `pnpm dev`**, so that restart-to-chat flow won't auto-recover. To
  reach the main console without it, `PUT /api/identity` (body `{identity, changedBy:"wizard"}`)
  to mark identity configured, then restart the backend yourself.

### Lint / typecheck / test / build (commands in `package.json`)
- Lint: `pnpm run lint` — covers `src/`, `tests/` and `apps/`. The browser apps get their
  own `eslint.config.js` block: no `no-console` there (pino is a Node logger), plus the
  React hooks rules. Not covered: `skills/**`, `scripts/**` and `packages/**`.
- Typecheck: `pnpm run typecheck` — 3 root tsconfigs (`src/`,
  `skills/`, `tests/`) plus **every** workspace package under `apps/*` and `packages/*`
  via `pnpm -r run typecheck`. No workspace package is checked separately; a per-package
  list here is how `apps/console` came to be missed (#1726). Not covered: `scripts/**`
  (#1729) and `apps/*/vite.config.ts` (which lint *does* cover). Build console:
  `pnpm --filter @curia/console run build`.
- Tests: `pnpm test` (vitest). Integration tests **require `DATABASE_URL`** and applied
  migrations; they `describe.skip` when it is unset. Mirror CI by using a separate
  `curia_test` DB: create it, migrate it, then
  `DATABASE_URL=postgres://curia:<pw>@localhost:5432/curia_test LOG_LEVEL=error pnpm test`.

### Git commits (DCO)
- Every commit must include a DCO `Signed-off-by:` trailer — CI blocks PRs without it.
  Always commit with `git commit -s` (or `git commit --signoff`). See `CONTRIBUTING.md`.
- If an already-pushed commit is missing sign-off, amend or `git rebase --signoff main`
  and force-push (fine when no review threads are in flight).

### GitHub PR review replies
When addressing review feedback (CodeRabbit, humans, Bugbot, etc.) on a PR this run owns:

1. **Post replies yourself** on the GitHub review thread. Never ask the user to
   copy-paste a reply into GitHub — that is an anti-pattern for this environment.
2. Use the Cursor **ManagePullRequest** tool (`action: post_comment`):
   - Inline thread reply: set `in_reply_to` to the numeric review-comment id
     (from `gh api repos/.../pulls/<n>/comments` or a permalink ending in
     `#discussion_r<id>`).
   - File/line note when there is no discussion id (e.g. a review-body nitpick):
     set `path` + `line` (and optional `side`).
   - Top-level note only when neither applies: `body` alone.
3. Do **not** use `gh pr comment`, `gh api` POST to review comments, or raw
   GraphQL — the cloud sandbox GitHub App token can push git but **lacks**
   issues/PR comment write scopes (`Resource not accessible by integration`).
4. After a confident fix: commit with `-s`, push the existing PR branch, then
   reply on the same thread citing the fix SHA. Use `resolve_comment` only when
   the user asks you to resolve, or when instructions for this run explicitly
   allow resolving fully-addressed threads.
5. If a comment needs human judgment: reply on the thread saying so — do not
   leave a "please paste this" draft in chat.

### Pull request bodies (no Cursor chrome)
When creating or updating a PR via **ManagePullRequest**, pass **only** the
human-readable description. Never include any of the following in `body`:

- `<!-- CURSOR_AGENT_PR_BODY_BEGIN -->` / `<!-- CURSOR_AGENT_PR_BODY_END -->`
- "Open in Web" / "Open in Cursor" buttons, badges, or image links
- `cursor.com/agents/...` run links or other cloud-agent deep links meant as PR chrome

If the platform re-injects those wrappers or footers after the call, do not add
a second copy, and do not ask the user to scrub them as part of the happy path.
There is currently **no** AGENTS.md or dashboard toggle that disables
server-side injection (Cursor staff confirmed; Attribution settings only cover
the separate "Made with Cursor" trailer).
