# ADR-004: pgvector over dedicated vector DB

Date: 2026-02-20
Status: Accepted

## Context

The knowledge graph needs vector similarity search for entity lookup and relationship queries. A dedicated vector database (Pinecone, Weaviate, Qdrant, Chroma) would provide purpose-built indexing and approximate nearest-neighbor search at scale. However, the system already depends on Postgres for all other persistence.

Options considered:
1. **Dedicated vector DB** (Pinecone, Qdrant, Chroma) — optimized for vector search; separate service to operate
2. **pgvector** — Postgres extension; same database, same connection pool, same backup strategy

## Decision

Use the pgvector Postgres extension with an HNSW index for vector similarity search.

Running a separate vector database was rejected because:
- **Operational overhead** — a second stateful service to deploy, monitor, backup, and keep in sync with Postgres. For a single-tenant system on a single VPS, this cost is not justified.
- **Consistency** — entity records and their embeddings live in the same Postgres transaction. A separate vector DB would require dual writes with failure modes (entity saved, embedding not; embedding updated, entity stale).
- **Scale** — at the expected volume (thousands to tens of thousands of entities for a single executive), pgvector's HNSW index is fast enough and requires no special tuning.

pgvector's HNSW index provides approximate nearest-neighbor search at sub-millisecond latency for this data scale. Exact k-NN is available as a fallback for correctness-sensitive queries.

## Consequences

- Entity embeddings and structured entity data are always consistent (same transaction).
- No additional service to deploy or monitor beyond what's already required.
- If the system ever needs to scale to millions of entities or serve many concurrent users, migrating to a dedicated vector DB would require a data migration and dual-write period.
- HNSW index build time grows with dataset size — at very large scale, index maintenance would need tuning. Accepted as a future concern.
