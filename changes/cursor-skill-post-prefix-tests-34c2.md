### Added

- **Behavior cases** — on-demand activation coverage cases 60a–60g for Layer 2 A/B. (#2764)
- **Over-activation checks** — `skills_activated.excludes` on design §10.B cases. (#2764)
- **Skill pre-activation** — unit coverage for conversation carry, bullpen, jobs, and digest. (#2764)
- **`principalReach`** — listed skill send tools still count toward the reach block. (#2764)
- **Conversation skill carry** — Postgres integration test for TTL, cap, and MRU. (#2764)

### Changed

- **Skill docs** — specs describe on-demand pins, pre-activation, and append-only bodies. (#2764)
- **Specs 19/20 + agent guide** — skill pins list only; body and tools load on activation. (#2764)
- **Case 60b** — accepts ceo-inbox delegate; require success on archive any_of. (#2764)
- **13a–e / 48l** — `skills_activated` includes/excludes for google-workspace. (#2764)
- **Case 13e** — drop duplicate critical `skills_activated.excludes` check. (#2764)
- **Pre-activation tests** — skill bodies asserted on after-history system rows. (#2764)
