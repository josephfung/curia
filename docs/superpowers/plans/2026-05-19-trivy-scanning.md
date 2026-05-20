# Trivy Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Trivy vulnerability scanning to CI with a filesystem/npm scan on every PR and a Docker image scan on the weekly schedule only.

**Architecture:** Single workflow file `.github/workflows/trivy.yml` with two jobs — `trivy-fs` scans source + npm deps on push/PR/schedule; `trivy-image` builds and scans the Docker image but only runs on the weekly schedule to avoid build overhead on every push or PR.

**Tech Stack:** GitHub Actions, `aquasecurity/trivy-action@master`, `github/codeql-action/upload-sarif@v4`

---

### Task 1: Create `.github/workflows/trivy.yml`

**Files:**
- Create: `.github/workflows/trivy.yml`

The repo already has `semgrep.yml` (cron `'0 7 * * 3'`) and `codeql.yml` (cron `'0 6 * * 3'`).
Trivy uses `'0 8 * * 3'` — staggered one hour after Semgrep on Wednesday.

All existing security workflows use:
- `actions/checkout@v6`
- `github/codeql-action/upload-sarif@v4` (not v3)
- `permissions: contents: read` + `security-events: write`
- `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env (matches `codeql.yml`)

- [ ] **Step 1: Create the workflow file**

Create `/Users/josephfung/Projects/worktrees/curia-trivy/.github/workflows/trivy.yml`:

```yaml
name: Trivy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 8 * * 3'  # Weekly, Wednesday — staggered from CodeQL (06:00) and Semgrep (07:00)

permissions:
  contents: read
  security-events: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

jobs:
  trivy-fs:
    name: Filesystem Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Run Trivy filesystem scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-fs.sarif'
          severity: 'CRITICAL,HIGH'
          ignore-unfixed: true
          skip-dirs: 'node_modules,dist'

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: trivy-fs.sarif
          category: trivy-fs
        if: always()

  trivy-image:
    name: Docker Image Scan
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v6

      - name: Build Docker image
        run: docker build -t curia:scan .

      - name: Run Trivy image scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'image'
          image-ref: 'curia:scan'
          format: 'sarif'
          output: 'trivy-image.sarif'
          severity: 'CRITICAL,HIGH'
          ignore-unfixed: true

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: trivy-image.sarif
          category: trivy-image
        if: always()
```

- [ ] **Step 2: Validate YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/trivy.yml'))" 
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-trivy add .github/workflows/trivy.yml docs/superpowers/plans/2026-05-19-trivy-scanning.md
git -C /Users/josephfung/Projects/worktrees/curia-trivy commit -m "feat: add Trivy scanning for npm deps, Docker image, and secrets

Closes #563

- trivy-fs: filesystem + npm dep scan on every push/PR/schedule
- trivy-image: Docker image scan on weekly schedule only (not per-push)
- CRITICAL,HIGH severity with ignore-unfixed: true
- Both jobs upload SARIF to GitHub Security tab"
```

- [ ] **Step 4: Create PR**

Run pre-PR review agents (per CLAUDE.md): `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` in parallel.

Then:

```bash
gh pr create \
  --repo josephfung/curia \
  --title "feat: add Trivy scanning for npm deps, Docker image, and secrets" \
  --body "..." \
  --head feat/trivy-scanning \
  --base main
```

Close issue #563 in the PR body.
