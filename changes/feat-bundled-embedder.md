### Added

- **Bundled embedding model** — knowledge graph works with only an Anthropic key: all-MiniLM-L6-v2 runs in-process, no network. (#2023)
- **`knowledge_graph` health check** — **public API:** `/api/health` gains `checks.knowledge_graph` and optional `details.knowledge_graph` reason. (#2023)
- **Embedding weight drift check** — Curia notices when an endpoint serves different weights under the same model name. (#2023)
- **`pnpm reembed:kg --force`** — re-embeds every row even when stamps match, recovering from endpoint weight drift. (#2023)

### Changed

- **Embedding default** — no `EMBEDDING_BASE_URL` now means the bundled model; existing graphs keep their model. (#2023)
- **Identifier guard** — labels with different order numbers, ids or phone numbers no longer auto-resolve or merge. (#2023)
- **Implicit OpenAI embeddings (deprecated)** — OpenAI without `EMBEDDING_BASE_URL` is deprecated and goes away in a later release. (#2023, #2628)
