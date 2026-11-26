### Changed

- **System prompt cache (#2774)** — system role is the stable prefix only; per-turn blocks (date/time, autonomy, verifications, reach, turn budget, skill bodies, harness, intent/scope) ride after history on the latest user message so OpenRouter/DeepSeek tool defs stay cacheable. (#2764)
