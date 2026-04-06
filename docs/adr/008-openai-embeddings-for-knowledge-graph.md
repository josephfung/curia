# ADR-008: OpenAI text-embedding-3-small for knowledge graph embeddings

Date: 2026-02-20
Status: Accepted

## Context

The knowledge graph stores entity embeddings to support vector similarity search (e.g., "find entities similar to this name or description"). An embedding model is needed to generate these vectors.

Options considered:
1. **Anthropic embeddings** — not available; Anthropic does not offer an embeddings API
2. **OpenAI text-embedding-3-small** — 1536-dimensional vectors, low cost, high quality at this dimension count
3. **OpenAI text-embedding-3-large** — 3072-dimensional vectors, higher quality, higher cost and storage
4. **Self-hosted (Ollama + nomic-embed-text)** — no API cost, privacy-preserving, but requires GPU or CPU inference infrastructure

## Decision

Use OpenAI `text-embedding-3-small` (1536 dimensions) with a pgvector HNSW index.

`text-embedding-3-small` was chosen because:
- **Quality at scale** — 1536 dimensions provides strong semantic similarity for entity names, descriptions, and relationship text at the expected data volume.
- **Cost** — `text-embedding-3-small` is significantly cheaper per token than `text-embedding-3-large` or `ada-002`, and the quality delta is not meaningful at this scale.
- **Latency** — API call latency is acceptable for offline embedding generation (contact creation, relationship extraction). It is not on the user-facing critical path.
- **Operational simplicity** — no self-hosted inference infrastructure required.

Anthropic was already the primary LLM provider, so using OpenAI for embeddings introduces a second vendor dependency. This is accepted because Anthropic offers no embedding API, and the embedding call is isolated behind an interface that could be swapped for a self-hosted model later.

## Consequences

- A second vendor API key (OpenAI) is required in addition to Anthropic.
- Embedding generation costs are incurred at contact creation and relationship extraction time — not on the read path.
- Changing the embedding model in the future would require re-embedding all existing entities (migration of the `kg_nodes.embedding` column). The HNSW index dimensions are fixed at creation time.
- pgvector stores embeddings as `vector(1536)` — the dimension is baked into the schema.
