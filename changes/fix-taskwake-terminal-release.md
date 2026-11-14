### Fixed

- **Task-wake reply binding** — a reply to an ended task's ask releases the entry instead of failing. (#2592)
- **Task-wake reply binding** — a task that ends releases its outstanding asks from the active outbound context. (#2592)
- **Task-wake reply binding** — a send after its task ended no longer binds replies to it. (#2592)
