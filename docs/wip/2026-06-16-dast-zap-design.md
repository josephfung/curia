# DAST — OWASP ZAP baseline scan (issue #568)

**Date:** 2026-06-16
**Status:** Approved (design)
**Issue:** #568 — security: add OWASP ZAP baseline DAST scan for the Fastify HTTP API

## Goal

Add a release-prep DAST scan that boots Curia's HTTP API in CI, runs an OWASP ZAP
passive (baseline) scan against the unauthenticated surface, and publishes results
both to the GitHub Security tab (SARIF) and as a downloadable HTML artifact. The
scan is **alert-only** initially — it never fails the job on findings — and runs on
a weekly schedule plus manual dispatch, not on every PR.

## Why ZAP Automation Framework instead of `action-baseline`

The issue's recipe uses `zaproxy/action-baseline`, but that action **cannot emit
SARIF natively**, and the acceptance criteria require SARIF in the Security tab.
The two ways to get SARIF are:

1. `action-baseline` + a third-party converter (`SvanBoxel/zaproxy-to-ghas`) — adds
   an unpinned third-party action that handles security results, which cuts against
   this repo's supply-chain posture (all actions SHA-pinned, Scorecard, least-privilege).
2. `zaproxy/action-af` (ZAP Automation Framework) with a `sarif-json` report template —
   first-party, SHA-pinnable, generates SARIF (and HTML) natively inside ZAP.

We chose **option 2**. The cost is one extra artifact: an Automation Framework plan
YAML. The benefit is no third-party security action and a cleaner SARIF path.

## Corrections to the issue's CI recipe

The issue's startup snippet is materially wrong about how Curia boots. Verified
against the actual code:

- **Secrets are vault-only.** `applyVaultSecrets()` (src/secrets/apply-vault-secrets.ts)
  resolves `api_token`, `anthropic_api_key`, `web_app_bootstrap_secret` (all required,
  fail-closed) from an encrypted Postgres vault. There is **no env fallback** — setting
  `ANTHROPIC_API_KEY` / `BEARER_TOKEN` env vars on the server process does nothing.
  CI must seed the vault after migrations via `scripts/seed-vault.ts`.
- **Port var is `HTTP_PORT`**, not `HTTP_API_PORT` (src/config.ts, default 3000).
- **`SECRET_ENCRYPTION_KEY` is required** at boot — base64 of 32 random bytes
  (src/secrets/crypto.ts). The seed script and the server must share the same key.
- The bearer token lives in the vault as `api_token`, seeded from the `API_TOKEN`
  env var read by `seed-vault.ts`.

## Components

### 1. `.github/workflows/dast.yml`

- **Triggers:** `workflow_dispatch` (optional `target_url` input, default the local
  test server) + `schedule` weekly Monday 09:00 UTC (staggered after the Wed SAST jobs).
- **Permissions:** top-level `contents: read`; the job adds `security-events: write`
  for the SARIF upload. No `issues: write` — we publish SARIF, not ZAP-created issues.
- **Postgres service:** `pgvector/pgvector:pg16`, same creds as `ci.yml`.
- **Boot sequence** (mirrors `ci.yml` where it overlaps):
  1. checkout / pnpm / Node 22 / `pnpm install --frozen-lockfile --ignore-scripts` /
     `pnpm rebuild esbuild`
  2. Generate `SECRET_ENCRYPTION_KEY` (`openssl rand -base64 32`) into `$GITHUB_ENV`
  3. Run migrations (same command as `ci.yml`)
  4. Seed the vault: `pnpm tsx scripts/seed-vault.ts` with `API_TOKEN`,
     `ANTHROPIC_API_KEY`, `WEB_APP_BOOTSTRAP_SECRET` set to CI placeholders. (Invoke
     `tsx` directly, not `pnpm run seed-vault`, to bypass its hardcoded `--env-file=.env`.)
  5. Start the server in the background: `pnpm tsx src/index.ts &` with `DATABASE_URL`,
     `HTTP_PORT=3000`, `SECRET_ENCRYPTION_KEY`.
  6. Poll `http://localhost:3000/api/health` until ready, with a hard fail if it never
     comes up (so a silent boot failure fails the job loudly instead of hanging until
     the ZAP step times out). On failure, dump the server log.
- **Scan:** `zaproxy/action-af` (SHA-pinned) with `plan: .zap/plan.yaml`.
- **Publish:** `actions/upload-artifact` for `dast.html` + `dast.sarif.json`;
  `github/codeql-action/upload-sarif` with `category: zap-dast`, `if: always()`.

### 2. `.zap/plan.yaml` — ZAP Automation Framework plan

- `env.contexts[0].urls`: `http://172.17.0.1:3000` — the ZAP container reaches the
  host-bound server (the API listens on `0.0.0.0:3000`, see http-adapter.ts:413) via the
  Docker bridge gateway. `localhost` inside the ZAP container would not reach the host.
- `env.parameters.failOnError: false` — alert-only.
- Jobs: `passiveScan-config` → `spider` → `passiveScan-wait` → `report`
  (`sarif-json` → `/zap/wrk/dast.sarif.json`) → `report` (`traditional-html` →
  `/zap/wrk/dast.html`). `/zap/wrk/` maps to the workspace.
- **Report filenames:** the `sarif-json` template's native extension is `.json` and
  ZAP appends it unless the name already ends in it, so we name the SARIF file
  `dast.sarif.json` — both to avoid a double extension and because `.sarif.json` is one
  of the two extensions `upload-sarif` accepts (a bare `.json` is rejected).

### 3. Suppressions

AF uses an `alertFilter` job, not the `.zap/rules.tsv` file the issue mentions (that
is an `action-baseline` concept). We do **not** ship an active filter job initially:
ZAP rejects an `alertFilter` job whose `alertFilters` list is empty, and we should not
guess at suppressions before seeing the first run. The plan instead carries a
documented, schema-correct, commented-out example block (ruleId + `newRisk: 'False
Positive'`, e.g. for `X-Frame-Options`/CSP header alerts that are irrelevant for a pure
JSON API) to be activated and tuned after the first run's findings are triaged. Each
real suppression must carry an inline justification comment.

## Networking note

ZAP runs in its own Docker container, so the scan target must be reachable from inside
that container. On Linux GitHub runners the Docker bridge gateway is `172.17.0.1`, and
the server binds `0.0.0.0`, so `http://172.17.0.1:3000` reaches it. This is the single
most failure-prone detail; the health-check poll uses `localhost` (host side) while the
ZAP plan uses the gateway IP (container side).

## Out of scope

- Authenticated scanning (the issue defers this; baseline covers the unauthenticated
  surface only).
- Failing CI on findings (`failOnError` stays false until a stable baseline exists).
- Triage of the first run's findings happens after the workflow is merged and dispatched
  once — follow-up issues for any FAIL-level alerts, per the issue's acceptance criteria.

## Acceptance criteria (from #568)

- [x] `dast.yml` present, triggerable manually and on weekly schedule
- [x] ZAP starts and scans the running Curia HTTP API (`/api/health` reachable)
- [x] Documented suppressions for known-safe API behavior (via a documented, commented
  `alertFilter` example, ready to activate after first-run triage)
- [x] ZAP report uploaded as CI artifact (HTML + SARIF)
- [x] SARIF results flow to the GitHub Security tab (`upload-sarif`)
- [ ] Initial findings triaged — done after the first dispatched run (post-merge)
- [x] `failOnError: false` initially (alert-only)
