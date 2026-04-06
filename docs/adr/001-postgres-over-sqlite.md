# ADR-001: Postgres over SQLite

Date: 2026-02-05
Status: Accepted

## Context

Curia is a long-running, VPS-hosted executive assistant that needs persistent storage for:
- Structured data (contacts, audit log, scheduled jobs, identity records)
- Vector embeddings for the knowledge graph (pgvector)
- Write-ahead audit logging with at-least-once delivery guarantees
- Concurrent access from multiple async layers (bus, agent runtime, skill execution)

SQLite was the simplest option for a single-user system deployed on a single VPS. However, the project also needed native vector similarity search and concurrent writer safety.

## Decision

Use PostgreSQL 16+ as the primary database.

Postgres was chosen over SQLite because:
- **pgvector** — native vector similarity search (HNSW index) is a first-class Postgres extension. SQLite's vector support is bolted-on and immature.
- **Concurrent writes** — Postgres handles concurrent writers from multiple async processes safely. SQLite's write lock model is fragile under high-concurrency async workloads.
- **Audit log guarantees** — write-ahead logging and transaction semantics ensure the audit record is durable before in-process delivery continues.
- **Deployment familiarity** — the existing `ceo-deploy` infrastructure (Hetzner VPS, Docker Compose) already runs Postgres for other services.

The single-tenant deployment model means Postgres doesn't need to scale horizontally — a single Postgres container is sufficient and simpler to operate.

## Consequences

- Vector similarity search and pgvector HNSW indexes are available natively.
- Integration tests require a running Postgres instance (Docker); no in-memory fallback for tests.
- The `pg` driver is used directly (no ORM) to keep SQL transparent and auditable.
- Horizontal scaling would require read replicas or connection pooling (pgBouncer) — accepted as out of scope for the single-tenant use case.
