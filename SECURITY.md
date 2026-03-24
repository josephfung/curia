# Security Policy

Security is the core design principle of Curia. We take vulnerability reports seriously.

## Reporting a Vulnerability

**Do NOT file a public GitHub issue for security vulnerabilities.**

Email **security@josephfung.ca** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if you have one)

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Scope

The following are in scope for security reports:

- Bus layer enforcement bypasses (a channel publishing unauthorized events)
- Audit log integrity issues (mutations, deletions, gaps)
- Secret leakage (secrets appearing in logs, LLM context, or API responses)
- Prompt injection via tool outputs or channel messages
- Authentication/authorization bypasses on the HTTP API
- Intent drift detection failures (agent acting outside its mandate undetected)
- Skill permission escalation (a skill accessing undeclared secrets or capabilities)

## Out of Scope

- Vulnerabilities in upstream dependencies (report to the dependency maintainer)
- Denial of service via resource exhaustion (covered by error budgets, but not a security vulnerability)
- Social engineering attacks against the project maintainer

## Disclosure Policy

We follow coordinated disclosure:

1. Reporter notifies us privately
2. We confirm and develop a fix
3. We release the fix
4. We publicly disclose the vulnerability (with credit to the reporter, if desired)

We aim to resolve critical vulnerabilities within 14 days of confirmation.

## Security Architecture

For details on Curia's security model, see [Audit & Security spec](docs/specs/06-audit-and-security.md).
