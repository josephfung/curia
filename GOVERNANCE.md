# Governance

This document describes how Curia is governed: who maintains it, what roles exist,
who holds access to sensitive project resources, and how those roles change. It
satisfies OpenSSF Baseline criteria **OSPS-GV-01.01** (members with access to
sensitive resources) and **OSPS-GV-01.02** (roles and responsibilities).

Curia is currently a **single-maintainer project**. This document is deliberately
lightweight and will grow as the maintainer base does.

## Roles

### Maintainer

Maintainers are responsible for the direction and health of the project. Their
responsibilities include:

- Reviewing and merging pull requests
- Triaging issues and setting priorities and milestones
- Cutting and publishing releases
- Responding to security reports (see [SECURITY.md](SECURITY.md))
- Administering the repository, CI, and project infrastructure
- Upholding and enforcing the [Code of Conduct](CODE_OF_CONDUCT.md)

**Current maintainers:**

| Name | GitHub | Role |
|---|---|---|
| Joseph Fung | [@josephfung](https://github.com/josephfung) | Lead maintainer |

### Contributor

Anyone who submits an issue, a pull request, or otherwise participates is a
contributor. Contributors are not required to hold any special access. Their
responsibilities are limited to following the [Contributing Guide](CONTRIBUTING.md)
and the [Code of Conduct](CODE_OF_CONDUCT.md), and to certifying the origin of
their contributions via the DCO sign-off (see *Sign-off* in
[CONTRIBUTING.md](CONTRIBUTING.md)).

## Access to sensitive resources

The following sensitive resources exist for this project, and access to each is
held by the maintainer(s) listed. This inventory is kept current as access
changes.

| Resource | Description | Access held by |
|---|---|---|
| **Repository administration** | Admin rights on `github.com/josephfung/curia` — branch protection, settings, collaborator management | Joseph Fung |
| **GitHub Actions secrets** | CI/CD secrets used by workflows (image registry credentials, signing/OIDC configuration, deploy credentials) | Joseph Fung |
| **Release & registry credentials** | Publishing releases and container images (GitHub Releases, GHCR) | Joseph Fung |
| **meetcuria.com infrastructure** | Website hosting (Cloudflare Pages), DNS, and the production deployment host | Joseph Fung |
| **Security contact** | Intake for private vulnerability reports (see [SECURITY.md](SECURITY.md)) | Joseph Fung |

Curia does not publish to the public npm registry; it is distributed as signed
container images and source tarballs attached to GitHub releases.

## Becoming a maintainer

As the project grows, new maintainers may be added. The process:

1. A prospective maintainer demonstrates sustained, high-quality contribution and
   good judgment over time — meaningful PRs, thoughtful reviews, and reliable
   participation.
2. An existing maintainer nominates them.
3. The current maintainers reach consensus to add them.
4. On agreement, the new maintainer is granted the appropriate access (repository
   permissions and any relevant secrets), this document's maintainer and access
   tables are updated in the same change, and the addition is recorded in the
   project history.

While Curia has a single maintainer, that maintainer makes these decisions. As the
maintainer base grows, decisions move to maintainer consensus.

## Removing access

Maintainer access is revoked when a maintainer steps down, becomes inactive for an
extended period, or violates the [Code of Conduct](CODE_OF_CONDUCT.md). When access
is revoked, the relevant credentials are rotated and the tables above are updated
in the same change.

## Decision making

While Curia is single-maintainer, the maintainer is the final decision maker on
technical direction, releases, and contribution acceptance, guided by the project's
[architecture principles](docs/specs/00-overview.md) and
[ADRs](docs/adr/). Significant architectural decisions are recorded as ADRs so the
reasoning is durable and reviewable. As the maintainer base grows, this section
will be updated to describe consensus-based decision making.

## Changes to this document

Changes to governance — roles, access, or process — are made via pull request and
recorded in the project history like any other change.
