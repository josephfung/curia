---
name: release
description: Use when preparing or cutting a Curia release - "prepare a release", "cut a release", "pre-release" checks (docs sync, security gate, behavior gate), "tag vX.Y", bumping the version, naming the release, or assembling the changelog fragments into CHANGELOG.md. Covers the whole procedure from pre-flight gates through tag, GitHub release, artifact verification and close-out.
---

# Preparing a release

Moved out of CLAUDE.md so it loads only when a release is actually being cut. Day-to-day PRs never
edit `CHANGELOG.md`: each adds a fragment `changes/<branch-name>.md` (format in `changes/README.md`),
and step 3 below merges them all. The release PR itself needs no fragment of its own — the new
release heading is the record. The bump-size table and the public-API list live in CLAUDE.md
(*When to bump the version number*).

A release is a deliberate, standalone step — separate from day-to-day PR work. Follow these steps in order.

**Pre-flight — get `main` release-ready (before the numbered steps)**

All three steps below happen *before* cutting the release, while there is still room to fix problems on a normal branch. Any fixes they need land as ordinary PRs — each with its own changelog fragment (`changes/<branch-name>.md`), which then rolls into this release — and never inside the release PR itself, which carries no code changes (step 6).

***A. Sync the documentation***

Bring the docs in line with what actually shipped this batch. Do this first, so the security gate below scans the final pre-release state.

- **Temporary (#872):** if `src/channels/http/routes/legacy-kg-aliases.ts` still exists **and the #872 CHANGELOG entry already sits under a released version heading**, open a follow-up to delete it (and its registration + tests) — one tagged release of stale-tab coverage is enough. Drop this bullet when that lands.

- **`docs/specs/`** — update the architecture specs so they describe the system as it now behaves. New capability shipped → its spec reflects it; behavior changed → the affected spec is corrected.
- **`docs/wip/`** — prune it. Remove artifacts whose work has shipped and been folded into `docs/specs/` (or is otherwise complete). Leave anything still in progress untouched.
- **`docs/dev/`** — update the how-to guides (`adding-a-tool`, `adding-an-agent`, `configuration`, `setup`, etc.) wherever this release changed the steps they describe.
- **curia-docs repo** — the public site (docs.meetcuria.com) lives in the separate `curia-docs` repo. Where this release changed user-facing behavior, update it there via its own PR. This is not part of the Curia release PR.

***B. Pre-release security gate***

Run the on-demand security scans against current `main` and clear them **before** cutting the release. Because the release PR carries no code changes (step 6), the commit you tag will be code-identical to what you scan here — so clearing the gate now means clearing it for the tag, while you can still fix findings on a normal branch instead of being stuck with a merged release commit you cannot tag.

(Trivy fs, Semgrep, and Gitleaks already run on every push/PR; this gate covers the scans that do *not* — the Docker image scan, a fresh CodeQL pass, the repo-level Scorecard, and the OWASP ZAP passive DAST run.)

```bash
gh workflow run trivy.yml     # on-demand Trivy image scan (base image + OS package CVEs)
gh workflow run codeql.yml    # fresh CodeQL security-extended pass (takes several minutes)
gh workflow run scorecard.yml # repo-level supply-chain posture
gh workflow run dast.yml      # OWASP ZAP passive DAST against the running HTTP API (slow: boots the full app)
# Wait for each to finish, then review results:
gh run list --limit 5
```

Review **GitHub → Security → Code Scanning** for the results of all scanners. **Block the release on any unresolved CRITICAL finding.** A HIGH is a judgment call — fix it or document why it's accepted (e.g. unreachable code path, no fix available) before proceeding.

Don't merge other code PRs between clearing this gate and tagging. If code lands on `main` after the gate clears, re-run it — the release PR adds no code, so the gate is only meaningful if `main` hasn't moved underneath it.

**Record the commit the scans ran against** (`git rev-parse origin/main`) — step 7 diffs against it to prove the gate still applies at tag time.

The ZAP DAST scan (`zap-dast` category) is alert-only and review-only for now — until its first run is triaged into the `alertFilter` baseline in `.zap/plan.yaml`, its findings are informational and do not block a release. Once a triaged baseline exists (and `failOnError` flips), treat its unresolved CRITICALs the same as the other scanners.

***C. Behavior gate***

Run the scenario suite against the **same `main` commit as the security gate**, on the standard-tier model the production deployment uses (its `model_routing.tiers.standard.model`, e.g. `deepseek/deepseek-v4.1-flash`).

The weekly workflow does this (`docs/dev/behavior-tests.md`, "The weekly run"). If its latest Sunday run was on that commit, that run is the gate: read its summary on the tracking issue. Otherwise run it on `main` now, which is that commit while nothing has merged since the security gate:

```bash
gh workflow run behavior-gate.yml   # about $1; its summary lands on the tracking issue
```

Without the workflow, run it from a worktree checked out at that commit:

```bash
docker stop curia-curia-1                       # scenarios refuses to run beside a live instance
CURIA_RELEASE_GATE=1 pnpm scenarios --model <standard-tier model>    # tests/scenarios/README.md
```

Scenarios needs a database whose principal is Avery Testwell, the principal its cases are written for. It refuses one that is not and prints how to make a copy (tests/scenarios/README.md, "The scenario principal"); point its `DATABASE_URL` at that copy.

`CURIA_RELEASE_GATE=1` marks the run as the release gate. The suite ignores it, but the maintainer's local guard refuses an unfiltered run without it (see Testing in CLAUDE.md).

The suite runs 4 cases at a time (`--concurrency`) and prints its spend by agent and judge. The gate is about 20 cases, each run 5 times against its pass rate (`tests/scenarios/README.md`, "The gate"). Record the actual time and spend with the results, and if the gate creeps back toward an hour, move cases on demand (`release_gate: false`) rather than accept it.

- **Block the release** if the command exits non-zero: a critical behavior below threshold. Judge errors and errored runs also fail the gate; re-run those rather than waving them through. A case marked `known_failure` is listed under known failures and not gated: confirm each one's issue is still open, because a marker on a closed issue would wave a regression through.
- **Record the results with their commit.** The suite prints the `Commit:` it ran on, and it must equal the commit the run was made for exactly — a `-dirty` suffix means uncommitted changes were tested, so the run does not count. The full run is made on the first gate commit; if fixes follow, the re-run cases are made on `<gate-sha>` (below), and both commits are recorded. Note the outcome (gate passed, plus any known failures) next to the security gate's.
- **Setup wizard walkthrough.** From the same worktree, also run `pnpm e2e:setup-wizard` (about a minute, no model spend; `docs/dev/setup-wizard-e2e.md`). It installs Curia into an empty throwaway database and clicks through `/setup` to `/chat` in Chromium — the first-run path the scenario suite doesn't reach (#2146). It uses its own database and port, so it can run beside the suite. **Block the release** if it exits non-zero, and record the result with the others.
- **One full run per release, then triage.** Never re-run the whole suite. Triage each failing case as `docs/dev/behavior-tests.md` ("Triage") says: a deterministic failure is a bug, root-caused within about an hour; a nondeterministic case below its threshold is compared with its baseline rate before anyone reads a transcript. Re-run a failing case alone on the same commit (`--case "<name>"`) first. No bisecting or A/B arms inside the release; that is an issue's work.
- Fixes and `known_failure` markers move `main`. Re-run B (CI, no model spend) on the new commit, and C **only for the cases that failed plus any case the fixes touch** (`--case`), on that commit. That commit is `<gate-sha>`; record the full run's commit beside it. Step 7's diff against `<gate-sha>` then proves the tag is code-identical to what the gates last checked.

With docs synced and both gates clear, cut the release:

**1. Read the unreleased changes**

Review everything pending: the entries under `## [Unreleased]` in `CHANGELOG.md` (anything left from before fragments) and every fragment in `changes/` (`changes/README.md` is not one). To see the merged result without touching any file:

```bash
pnpm changelog:assemble --dry-run
```

Read for themes: what capabilities shipped, what was fixed, what changed under the hood.

**2. Name the release and determine the version bump**

Name each release after a sci-fi character whose nature embodies the dominant theme of the changes. Choose characters that readers are likely to know; draw from a broad canon (films, novels, games — not just one franchise). The fit should be genuinely tight, not forced. If no character fits well, defer to a short evocative phrase.

**Names are never reused. List the ones already taken before you pick:**

```bash
grep '^## \[' CHANGELOG.md
```

Every prior release name is in that output. Check the *character*, not the release theme — the same character can fit two releases for entirely different reasons, and it is still a collision (v0.31.0 and a proposed v0.43.0 both landed on TARS, one for carrying messages across the tesseract, one for the honesty setting). Also note which canons are already heavily drawn on; by twenty releases in, Star Trek and Dune will each have been used more than once, and reaching for an untouched canon usually produces a better name than squeezing a third character out of a used one.

Use the bump table in CLAUDE.md (*When to bump the version number*) to determine the version bump. If the unreleased batch mixes types, the highest applicable bump wins (any minor → minor; all patches → patch).

**3. Update CHANGELOG.md**

- Run the assembler. It creates a new heading immediately after `## [Unreleased]`:
  ```
  ## [X.Y.Z] — YYYY-MM-DD — "Character Name"
  ```
  moves all `[Unreleased]` bullets and every `changes/*.md` fragment under it (one group per section, in a stable order), leaves `## [Unreleased]` in place above it, empty, ready for the next batch, and deletes the merged fragments. `--date` defaults to today (UTC). Preview first with `--dry-run`:
  ```bash
  pnpm changelog:assemble --dry-run --version X.Y.Z --name "Character Name"
  pnpm changelog:assemble --version X.Y.Z --name "Character Name"
  ```
  It refuses to write anything if a fragment is invalid or the version already has a heading. Commit the deleted fragments with the release PR.
- Immediately below the new heading, add a blockquote with the character's name, source (work + year + creator), and a brief statement about who they are and why the fit is apt:
  ```
  > **Character Name** *(Work, Year, creator)* — one or two sentences: who they are, what defines them, and why this release embodies that.
  ```
- Condense and group the bullets — aim for clarity over completeness. Merge related entries, cut implementation detail, and make it readable to someone who uses Curia but didn't write the code. The CHANGELOG is a reader document, not a commit log.

**4. Update version numbers**

This is the **only** place the version is bumped. Day-to-day PRs never touch `package.json`'s version or the README badge — a feature branch that bumps it is wrong, and two unmerged branches that both bump it will conflict. The version moves once, here, in the release PR.

- **Agent and skill versions** — PRs never bump `version` in `agents/*.yaml`, `tool.json` or a bundle's `SKILL.md`; this is where they move. For a **minor** bump on an agent or skill (new capability, new input/output field, new pinned skill), set that file's version by hand first. Then preview and apply the patch bumps for everything else that changed since the last `v*` tag:
  ```bash
  pnpm bump:versions           # dry run: lists each file and its old -> new version
  pnpm bump:versions --write   # apply
  ```
  The script skips a file whose version already differs from the last tag's, so your hand-set bumps stay and re-running is safe. Commit the result with the release PR. These files change only on their `version` line; step 7 checks that.
- `package.json` → `"version": "X.Y.Z"`
- `README.md` → update the shields.io version badge: both the URL (`version-X.Y.Z`) and its `alt` attribute (`Version: X.Y.Z`). Find it rather than trusting a line number — `grep -n 'shields.io/badge/version' README.md`.
- If this release changed a **runtime** requirement (Node, pnpm, Postgres), also update the matching README badge, `engines` in `package.json`, and any version named in CLAUDE.md.

**5. Generate a release haiku**

Write a haiku thematically aligned with the release — drawn from the changes, the fixes, the dominant mood. It should feel like a small hidden gift at the end of the release notes, not a gimmick. Tone: quiet, precise, a little wry.

**6. Open a release PR**

- Branch: `chore/release-X.Y.Z`
- PR title: `chore: release vX.Y.Z — "Character Name"`
- PR body: the character blockquote, followed by the new CHANGELOG section, followed by the haiku
- No other code changes — this PR is the release commit only (`CHANGELOG.md`, `README.md`, `package.json`, the deleted `changes/*.md` fragments, and the `version` line of the agent YAMLs, `tool.json` files and bundle `SKILL.md` files that `pnpm bump:versions` touched)
- Watch CI; wait for merge before proceeding

**7. Tag and publish**

Tag `origin/main` directly (do not rely on local branch state — the release worktree is on `chore/release-X.Y.Z`, not `main`).

Two things must both be true before you tag: the release PR actually merged, and no code has landed since the security and behavior gates cleared. Check both explicitly. A bare `grep "X.Y.Z"` on `CHANGELOG.md` is a weak proxy for the first and says nothing about the second — it is an unanchored substring match, so it also hits the `[X.Y.Z]:` compare-link definitions at the bottom of the file and any bullet that happens to cite a version number, and the dots are regex wildcards. Anchor on the heading instead, and corroborate with `package.json`.

```bash
git -C /path/to/repo fetch origin main

# 1. The merge landed: the version heading exists AND package.json agrees.
#    Both must return a result before proceeding.
git -C /path/to/repo show origin/main:CHANGELOG.md | grep '^## \[X.Y.Z\]'
git -C /path/to/repo show origin/main:package.json | grep '"version": "X.Y.Z"'

# 2. The gate still applies: nothing but the release files changed since the
#    commit the scans ran against (plus the deleted fragments, and the agent and
#    skill files whose only change is their version line).
#    <gate-sha> is the commit that was on main when pre-flights B and C cleared.
git -C /path/to/repo diff --stat <gate-sha> origin/main
#    expect exactly: CHANGELOG.md, README.md, package.json, the deleted
#    changes/*.md fragments, and agents/*.yaml, tool.json and SKILL.md files
git -C /path/to/repo diff --name-status --diff-filter=AMR <gate-sha> origin/main
#    expect exactly (nothing added or renamed; fragments only ever show as D above):
#    M CHANGELOG.md, M README.md, M package.json, and M for each version-bumped
#    agents/*.yaml, **/tool.json, skills/*/SKILL.md
#    The bumped files must differ only on their version line. Zero lines expected.
#    The output indicators mark content lines with < and >, so the file headers
#    (---/+++) never need filtering and a content line starting "-- " still shows:
git -C /path/to/repo diff -U0 --output-indicator-new='>' --output-indicator-old='<' <gate-sha> origin/main -- agents skills | grep -E '^[<>]' | grep -vE '^[<>](version:[[:space:]]*"?[^"[:space:]]+"?|  "version":[[:space:]]*"[^"]+",?)[[:space:]]*$'

# Tag origin/main directly — no checkout or pull needed
git -C /path/to/repo tag -a vX.Y.Z -m "vX.Y.Z — Character Name" origin/main
git -C /path/to/repo push origin vX.Y.Z
```

If those diffs show anything else (a bumped file with a change beyond its version line counts), code landed after the gates cleared. Re-run pre-flights B and C against the new `main` before tagging — this check is what makes the no-code release PR worth the ceremony, so skipping it forfeits the guarantee the whole ordering exists to provide.

Then write the release notes (open with the character blockquote; rewrite the CHANGELOG bullets into natural, friendly prose — past tense, as if narrating what changed; prioritize what a user of Curia would care about; close with a horizontal rule and the haiku) and create the GitHub release:

```bash
gh release create vX.Y.Z \
  --title 'vX.Y.Z — "Character Name"' \
  --notes "$(cat <<'EOF'
[character blockquote here]

[release prose here]

---

[haiku here]
EOF
)"
```

Tagging stays `git tag -a` (annotated, **unsigned**) — releases are signed at the artifact layer (step 8), not the tag.

**8. Verify release artifacts (SBOM + signatures)**

Publishing the release triggers `release.yml`, which generates an SPDX SBOM, a source tarball, and the operator install bundle (`install.sh` + `docker-compose.yml` + `docker-compose.tls.yml` + `env.example` + `Caddyfile` + `setup-common.sh` + `seccomp-chrome.json`), signs the SBOM, tarball, and a `SHA256SUMS` manifest with cosign (keyless, via GitHub OIDC), and attaches all **thirteen** files to the release. This step is **not optional and not silent** — the workflow fails loudly if anything is missing or a signature fails to verify (this is the fix for v0.34.0, which shipped with no SBOM because the old auto-attach skipped silently).

Confirm the workflow succeeded and all thirteen assets are present:

```bash
gh run list --workflow=release.yml --limit 1   # must be green
gh release view vX.Y.Z --json assets --jq '.assets[].name'
# expect (13): sbom.spdx.json, sbom.spdx.json.sigstore, curia-vX.Y.Z.tar.gz,
#   curia-vX.Y.Z.tar.gz.sigstore, install.sh, docker-compose.yml,
#   docker-compose.tls.yml, env.example, Caddyfile, setup-common.sh,
#   seccomp-chrome.json, SHA256SUMS, SHA256SUMS.sigstore
```

If the run failed or assets are missing, re-run it (do **not** consider the release done until they are present):

```bash
gh workflow run release.yml -f tag=vX.Y.Z
```

Anyone can verify a downloaded artifact against the GitHub Actions OIDC issuer:

```bash
# The signer identity is release.yml in this repo. The ref after @ is the tag
# (refs/tags/vX.Y.Z) for a normally-published release, or refs/heads/main for a
# release whose artifacts were built via the workflow_dispatch backfill path
# (e.g. v0.34.0). The regexp below matches both; tighten the @ suffix if you
# know which path produced a given release.
cosign verify-blob --bundle sbom.spdx.json.sigstore \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/<owner>/curia/.github/workflows/release.yml@' \
  sbom.spdx.json
```

**9. Verify the image publish, then close out**

Tagging also triggers `docker-publish.yml`. A green run is not enough — that workflow has historically published the *wrong* thing (retagged `:edge` backwards, moved `:latest` on a malformed tag). Check the registry itself:

```bash
gh api "users/<owner>/packages/container/curia/versions?per_page=10" \
  --jq '.[] | "\(.updated_at)\t\(.metadata.container.tags | join(", "))"'
# expect the new release to carry: vX.Y, vX.Y.Z, latest
# `edge` should sit on main's own build, not on the release
# (untagged rows are expected: each platform is pushed by digest, then joined)

docker buildx imagetools inspect ghcr.io/<owner>/curia:vX.Y.Z
# expect both linux/amd64 and linux/arm64 under Manifests
```

Then close out the release:

- **Close the milestone** — it should read 0 open. (`gh api -X PATCH repos/<owner>/curia/milestones/<n> -f state=closed`)
- **Remove merged worktrees and branches** — the docs-sync and release worktrees are both disposable once merged:
  ```bash
  git -C /path/to/repo worktree remove /path/to/worktrees/<name>
  git -C /path/to/repo branch -d <branch>
  git -C /path/to/repo worktree list   # confirm only active work remains
  ```
- **`main` is unfrozen.** The gate's "don't merge code PRs" hold ends at the tag, so anything parked for the release window can go in now.
