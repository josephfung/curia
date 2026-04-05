# feat: Office Identity Engine

## Summary

Implement the Office Identity system as defined in `docs/specs/13-office-identity.md`.

Currently, the coordinator's persona (name, tone, title) is configured directly inside `agents/coordinator.yaml`. This works but has two problems: (1) personality is buried in an agent definition instead of being a first-class instance concern, and (2) there's no way to update it at runtime without editing a file and restarting.

This issue implements a proper identity layer: a separate config file, a versioned DB store, a service class, and the coordinator injection point. The onboarding wizard (separate issue) will build on top of this.

## Scope

- New config file: `config/office-identity.yaml`
- New service: `OfficeIdentityService` (`src/identity/`)
- DB migration: `office_identity_versions` + `office_identity_current` tables
- Coordinator injection: `${office_identity_block}` token replaces `persona.*` fields
- HTTP API: `GET/PUT /api/identity`, `GET /api/identity/history`, `POST /api/identity/reload`
- Hot reload: file watcher + API-triggered reload
- Audit event: `config.change` on every identity update

## Acceptance Criteria

- [ ] `config/office-identity.yaml` exists with the schema from spec 13
- [ ] On first startup with no DB record, the YAML is loaded and seeded as version 1
- [ ] On subsequent startups, the DB version takes precedence over the YAML file
- [ ] `OfficeIdentityService.get()` returns the in-memory cached identity
- [ ] `OfficeIdentityService.update()` writes a new DB version, updates cache, emits audit event
- [ ] `compileSystemPromptBlock()` produces the correct ordered output (constraints first)
- [ ] The coordinator system prompt uses `${office_identity_block}` — not hardcoded persona fields
- [ ] Editing `config/office-identity.yaml` triggers a reload on the next coordinator turn
- [ ] `PUT /api/identity` saves a new version and triggers hot reload
- [ ] `GET /api/identity/history` returns all versions, newest first
- [ ] Existing `persona.*` fields in `coordinator.yaml` are removed as part of this PR (migration happens at startup)
- [ ] A `config.change` audit event is emitted with version number and diff summary on every change

## Implementation Notes

- `OfficeIdentityService` is a System-layer service, initialized in `src/index.ts` before the coordinator boots
- Use `chokidar` (already likely present or small dep) for file watching
- The DB `changed_by` field should record `'file_load'` on startup seed, `'api'` for direct API calls, and `'wizard'` for wizard submissions
- The `compileSystemPromptBlock()` output is injected at the start of each coordinator turn, not baked into the agent YAML — same pattern as `${current_date}` and `${agent_contact_id}`
- Constraints are compiled into a clearly labeled section placed above all other identity content

## Spec

`docs/specs/13-office-identity.md`
