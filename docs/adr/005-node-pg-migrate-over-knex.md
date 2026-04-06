# ADR-005: node-pg-migrate over Knex for migrations

Date: 2026-02-20
Status: Accepted

## Context

The system needs a database migration strategy for evolving the Postgres schema over time. The main options considered were:

1. **Knex** — query builder that includes a migration system; migrations written in JavaScript/TypeScript using a fluent API
2. **node-pg-migrate** — migration runner only; migrations are plain SQL files with an optional JS/TS wrapper
3. **Prisma** — full ORM with its own migration system and schema language

## Decision

Use node-pg-migrate with plain SQL migration files.

Knex and Prisma were rejected because:
- **ORM coupling** — Knex's migration API encourages using Knex's query builder in migrations. If Knex is later replaced or upgraded, migrations become a liability. Plain SQL has no coupling.
- **Readability** — SQL migrations are readable by any database engineer without framework knowledge. Knex migrations require understanding the Knex fluent API to audit.
- **Debuggability** — a plain SQL migration can be run directly in `psql` for inspection or manual correction. A Knex migration cannot.
- **Prisma overhead** — Prisma's schema language and migration system add significant abstraction that isn't needed when queries are written directly with `pg`.

node-pg-migrate is a thin runner: it tracks which migrations have run, executes them in order, and handles `up`/`down` transitions. The migrations themselves are plain SQL, which gives maximum portability and auditability.

## Consequences

- Any database engineer can read and audit the migration history without framework knowledge.
- Migrations can be tested by running them directly in `psql` before deploying.
- Complex operations (e.g., data backfills alongside schema changes) require raw SQL, which is more verbose than a query builder but more explicit.
- There is no ORM — all queries are written with parameterized `pg` calls. This is a deliberate choice (see design principle: "everything is auditable") but means more boilerplate than an ORM would produce.
