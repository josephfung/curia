# Dependency Management Policy

This document describes how Curia selects, obtains, and tracks its third-party
dependencies. It exists both as a contributor guide and as the project's stated
policy for supply-chain hygiene (OpenSSF Baseline **OSPS-DO-06.01**).

The practices here are not aspirational — they are already enforced by CI, the
lockfile, and automated tooling. This page documents what the machinery does and
why.

## Selecting a new dependency

Adding a dependency is a long-term commitment: every package we pull in becomes
part of our attack surface and our maintenance burden. Before adding one, weigh:

- **Is it necessary?** Prefer the standard library or a few lines of our own code
  over a dependency for trivial functionality. A small, well-understood
  implementation we own is often cheaper than a dependency we have to track,
  update, and audit forever.
- **Is it maintained?** Look at recent release cadence, open-issue responsiveness,
  and whether the project is actively developed or effectively abandoned.
- **Is it healthy?** Consider the size of the maintainer base (bus factor),
  download counts, and whether it has a history of security advisories and how
  quickly they were addressed.
- **What does it drag in?** A package with a deep transitive tree multiplies the
  surface we have to track. Fewer, shallower dependency trees are preferable.
- **Is the license compatible?** Curia is MIT-licensed. New dependencies must
  carry a permissive, compatible license (MIT, BSD, Apache-2.0, ISC, etc.).
  Copyleft licenses (GPL/AGPL) are not compatible and must not be introduced.

A dependency that fundamentally shapes the system (a new database engine, a core
framework, a new external API the architecture depends on) also warrants an
[Architecture Decision Record](../adr/) documenting why it was chosen over the
alternatives.

## Obtaining dependencies

- **Package manager: pnpm.** Curia uses pnpm exclusively. Do not use `npm` or
  `yarn` to install — they will not respect the workspace configuration or the
  overrides described below.
- **Lockfile is authoritative.** `pnpm-lock.yaml` pins the exact resolved version
  and integrity hash of every dependency, direct and transitive. It is committed
  to the repo and is the source of truth for what actually gets installed.
- **CI installs are frozen.** Continuous integration runs `pnpm install
  --frozen-lockfile`, which fails the build if `package.json` and
  `pnpm-lock.yaml` disagree. This guarantees CI, and by extension production,
  installs exactly the reviewed set of versions — a PR cannot silently pull in an
  unpinned or drifted dependency.
- **New-version quarantine.** Newly published package versions are held for a
  cooldown window before they are proposed (see Dependabot below), reducing the
  risk of installing a freshly compromised release before it is caught and yanked.

When you add or update a dependency locally, run `pnpm install` to regenerate the
lockfile and commit **both** `package.json` and `pnpm-lock.yaml` together in the
same change.

## Tracking and updating dependencies

### Automated updates — Dependabot

`.github/dependabot.yml` configures weekly Dependabot runs across four ecosystems:

- **npm** — production dependencies get individual PRs; dev dependencies are
  grouped into a single PR to reduce noise.
- **GitHub Actions** — action versions (`checkout`, `setup-node`, etc.) are kept
  fresh and grouped.
- **Docker** — the root `Dockerfile` base image (`node:24-slim`) and
  `docker/postgres.Dockerfile` (`pgvector/pgvector:pg16`) are digest-pinned and
  kept current within their pinned major.

Key policies encoded there:

- **7-day cooldown** on version updates, so a freshly published (and possibly
  compromised) release is skipped until it has survived a week in the wild.
  **Security updates from Dependabot alerts bypass the cooldown** — CVE patches
  are never delayed.
- **Major-version pins** where a major bump requires a deliberate migration rather
  than an automatic update: `node` (stays on Active LTS 24), `pgvector/pgvector`
  (pg16 → pg17 needs a DB upgrade), `@types/node` (tracks the Node runtime line),
  and `nylas` (an anomalous higher-numbered publish that is not the maintained
  `latest` line).

### Security pins — the `overrides` block

When a transitive dependency carries a CVE but the direct dependency that pulls it
in has not yet released a fix, we force a patched version using the `overrides:`
block in **`pnpm-workspace.yaml`** (not `package.json` — pnpm v10+ ignores
`package.json#pnpm.overrides` entirely).

Each override pins a minimum safe floor and carries an inline comment citing the
CVE or advisory it resolves. After editing an override:

1. Run `pnpm install` and confirm the regenerated `pnpm-lock.yaml` contains a
   top-level `overrides:` section.
2. Confirm the pin took effect with `pnpm why <pkg>` (it must show the forced
   version).

If `pnpm install` reports "Already up to date" after editing an override, pnpm did
not see the change — verify you edited `pnpm-workspace.yaml` and not
`package.json`.

### Build-script approvals — the `allowBuilds` block

pnpm blocks dependency postinstall/build scripts by default. Packages that
genuinely need to run a build step (e.g. `esbuild` downloading its platform
binary) are explicitly allowed in the `allowBuilds:` block of
`pnpm-workspace.yaml`. Values must be booleans; a pre-commit hook rejects any
placeholder text. Use `pnpm approve-builds` to review and approve new build
scripts interactively rather than hand-editing the file.

### Software Bill of Materials (SBOM)

Every push to `main` generates an SPDX-format SBOM via
`.github/workflows/sbom.yml`, giving supply-chain visibility into exactly which
components ship in a build. Release builds additionally generate a signed SBOM
that is attached to the GitHub release (see `.github/workflows/release.yml`), so
downstream consumers can verify the exact component set of any tagged version.

### Continuous scanning

Dependency and code scanning run on every push and pull request:

- **Trivy** — filesystem and container-image CVE scanning.
- **Semgrep** — static analysis for insecure patterns.
- **Gitleaks** — secret scanning.
- **CodeQL** — deep security analysis (`security-extended`).
- **OpenSSF Scorecard** — repository-level supply-chain posture.

Results surface under **GitHub → Security → Code Scanning**. Unresolved CRITICAL
findings block a release; HIGH findings are a documented judgment call. The full
pre-release security gate is described in [CLAUDE.md](../../CLAUDE.md) under
*Preparing a release*.

## Summary

| Concern | Mechanism |
|---|---|
| Selection | Necessity / maintenance / health / license review; ADR for shaping deps |
| Obtaining | pnpm + committed `pnpm-lock.yaml`; `--frozen-lockfile` in CI |
| Updating | Weekly Dependabot (npm, Actions, Docker) with 7-day cooldown |
| CVE pins | `overrides:` block in `pnpm-workspace.yaml`, one comment per CVE |
| Build scripts | `allowBuilds:` block, boolean-enforced by pre-commit hook |
| Inventory | SPDX SBOM on every `main` push; signed SBOM per release |
| Scanning | Trivy, Semgrep, Gitleaks, CodeQL, Scorecard on push/PR |
