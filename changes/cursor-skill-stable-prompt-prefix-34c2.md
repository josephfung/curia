### Changed

- **Pre-activated skills** — bodies are an after-history system row, not user turn context. (#2764)
- **System prompt cache (#2774)** — system role is stable prefix only; per-turn blocks ride after history. (#2764)
- **Adapter coverage** — Anthropic/Bedrock merge after-history skill bodies into `system`. (#2764)
- **Context budget** — pre-activated skill bodies reserved before history allocation. (#2764)
