# Contributing to Curia

Thank you for your interest in contributing to Curia. This document explains how to get involved, what we expect from contributions, and how to set up your development environment.

## Getting Started

1. Read the [architecture overview](docs/specs/00-overview.md) to understand the design philosophy
2. Check [open issues](https://github.com/josephfung/curia/issues) — look for `good first issue` labels
3. Fork the repo and create a feature branch

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/curia.git
cd curia
cp .env.example .env
# Edit .env with your API keys
docker compose up
```

Requires: Node.js 22+, Docker, PostgreSQL 16+ (via Docker Compose).

## Making Changes

### Branch Naming

Use conventional prefixes:
- `feat/` — new features
- `fix/` — bug fixes
- `chore/` — maintenance, docs, tooling

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Signal channel adapter
fix: prevent infinite retry loop in scheduler
chore: update pgvector to 0.8.0
```

### Code Standards

- **TypeScript ESM** — `"type": "module"`, `.js` extensions on imports
- **No `any` types** — use proper types or generics
- **Parameterized SQL** — never interpolate variables into SQL strings
- **Structured error handling** — no empty `catch {}` blocks (see [error recovery spec](docs/specs/05-error-recovery.md))
- **Structured logging** — use pino, never `console.log`
- **Comment liberally** — explain *why*, not just *what*

### Testing

- Write tests for new features and bug fixes
- Run the full test suite before submitting: `pnpm test`
- Integration tests should use real Postgres (via Docker), not mocks

### Pull Requests

- Keep PRs focused — one logical change per PR
- Reference the issue number if applicable
- Fill out the PR template
- Ensure CI passes before requesting review

## Architecture

Curia uses a message bus architecture with five layers — four domain layers with hard security boundaries, plus a System layer for trusted cross-cutting infrastructure. Before proposing changes, understand which layer your change affects:

- **Channel Layer** — input/output adapters (Signal, Email, etc.)
- **Dispatch Layer** — routing, policy enforcement
- **Agent Layer** — LLM-powered agent execution
- **Execution Layer** — skill invocation, MCP clients
- **System Layer** — trusted infrastructure with full pub/sub access (audit logger, memory engine, scheduler)

Each layer has strict bus permissions. See [architecture overview](docs/specs/00-overview.md) for details.

## Developer Guides

Step-by-step guides for common extension tasks — more detail than the quick references below:

- [**Adding an Agent**](docs/dev/adding-an-agent.md) — full YAML schema reference, skill pinning, autonomy injection, lifecycle hooks
- [**Adding a Skill**](docs/dev/adding-a-skill.md) — manifest fields, `action_risk` and the autonomy gate, handler interface, secrets, testing checklist

## Adding a New Channel Adapter

1. Create `src/channels/<name>/` with a class implementing `ChannelAdapter`
2. Add channel config to `config/default.yaml`
3. Write unit tests in `tests/unit/channels/<name>/`
4. Document in [channels spec](docs/specs/04-channels.md)

## Adding a New Skill

See the full [Adding a Skill guide](docs/dev/adding-a-skill.md) for schema details, `action_risk` values, and a pre-PR checklist. Quick reference:

1. Create `skills/<name>/` with `skill.json` manifest and `handler.ts`
2. Write tests in `skills/<name>/handler.test.ts`
3. Declare `action_risk`, `sensitivity`, permissions, and secrets in the manifest

## AI-Assisted Contributions

AI-assisted contributions (Claude Code, Copilot, Codex, etc.) are welcome. We evaluate code quality, not authorship. Requirements:

- **You must understand and be able to explain any code you submit** — if asked during review, you should be able to discuss the design choices
- **Same standards apply** — AI-generated code must pass lint, tests, type checks, and code review like any other contribution
- **Disclose substantial AI use** — if a PR is predominantly AI-generated, note this in the PR description. This is for transparency, not gatekeeping.
- **`CLAUDE.md` is your friend** — contributors using Claude Code will automatically follow project conventions via the repo-level CLAUDE.md

## Reporting Issues

- **Bugs**: Use the bug report issue template
- **Features**: Use the feature request issue template
- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) — do NOT file a public issue

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold these standards.

## Questions?

Open a [Discussion](https://github.com/josephfung/curia/discussions) for questions that aren't bugs or feature requests.
