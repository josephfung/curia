### Changed

- **System prompt cache (#2774)** — system role is the stable prefix only. Per-turn
  blocks (date/time, autonomy, verifications, reach, turn budget, skill bodies,
  planned-task / resumable harness, original-intent and scheduled-scope) ride after
  conversation history on the latest user message, so OpenRouter/DeepSeek tool defs
  stay cacheable when the skill set is unchanged. (#2764)
