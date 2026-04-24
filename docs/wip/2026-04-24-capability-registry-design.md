# Per-Capability Skill Registry

**Issue:** #119
**Date:** 2026-04-24
**Status:** Design approved, pending implementation

## Problem

The `infrastructure: true` flag in `skill.json` is a boolean that grants every
privileged service in `SkillContext` to any skill that declares it. 50 skills
currently set this flag. The flag is self-declared and grants: `bus`,
`agentRegistry`, `outboundGateway`, `heldMessages`, `schedulerService`,
`entityMemory`, `nylasCalendarClient`, `bullpenService` — all at once,
regardless of what the skill actually needs.

Two concrete risks:

1. **Over-broad access** — a calendar skill gets `bus` and `agentRegistry`
   access it never uses, widening blast radius if the handler has a bug or is
   fed malicious input.
2. **Accidental escalation** — a developer copy-pasting a skill.json from an
   existing infrastructure skill carries `infrastructure: true` into a new
   skill that doesn't need it.

Three additional services (`autonomyService`, `browserService`, `skillSearch`)
are separately name-gated in `execution.ts` via per-skill `if` blocks. These
are correct but use a different pattern, making the privilege model harder to
audit.

## Solution

Replace `infrastructure?: boolean` with `capabilities?: string[]` in the skill
manifest. Skills declare exactly which privileged services they need:

```json
{
  "name": "email-send",
  "capabilities": ["outboundGateway"]
}
```

### Load-time validation

The loader validates declared capabilities against a fixed allowlist of known
capability names. Unknown names fail hard at startup (crash, not silent skip).
After validation, the manifest is frozen with `Object.freeze()` — no runtime
mutation is possible.

```typescript
const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway', 'heldMessages',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'browserService', 'bullpenService', 'skillSearch',
]);
```

This set only changes when a new service type is added to the platform — not
when a new skill is added. Adding a new skill that needs `outboundGateway` is a
skill.json-only change.

### ExecutionLayer rewrite

The ~50-line `if (manifest.infrastructure)` block and 3 separate name-gated
conditionals are replaced by a single loop over `manifest.capabilities`:

```typescript
const caps = manifest.capabilities ?? [];

for (const cap of caps) {
  if (cap === 'entityMemory') {
    if (!this.entityMemory) {
      // Missing service — fail closed (see error handling below)
      continue;
    }
    // Special case: wrap with audit observer when audit context is available
    ctx.entityMemory = memAudit && this.bus
      ? buildEntityMemoryObserver(this.entityMemory, this.bus, memAudit, skillLogger)
      : this.entityMemory;
  } else if (cap === 'skillSearch') {
    // Special case: closure over registry, not a service reference
    ctx.skillSearch = (query: string) =>
      this.registry.search(query)
        .filter(s => s.manifest.name !== 'skill-registry')
        .map(s => ({ name: s.manifest.name, description: s.manifest.description }));
  } else {
    const service = this[cap as keyof this];
    if (!service) {
      // Missing service — fail closed (see error handling below)
      continue;
    }
    (ctx as Record<string, unknown>)[cap] = service;
  }
}
```

**Missing service error handling:** After the loop, check whether every declared
capability was satisfied. If any service was missing, log an error and return a
skill error before invoking the handler. This is fail-closed — a skill that
declares a capability it can't receive does not run at all. This replaces the
existing bus/agentRegistry-specific check with a per-capability version.

### Services that remain universal

These are NOT in the capabilities system — available to every skill:

- **`contactService`** — read-only contact lookups (documented as universal in
  types.ts, confirmed intentional)
- **`entityContextAssembler`** — read-only entity context pipeline (injected
  unconditionally since it's no more privileged than contactService)
- **`agentPersona`** — agent display name, title, and email signature

### Services that move into the capabilities system

Everything currently behind `if (manifest.infrastructure)`:
`bus`, `agentRegistry`, `outboundGateway`, `heldMessages`, `schedulerService`,
`entityMemory`, `nylasCalendarClient`, `bullpenService`

Plus the three currently name-gated in separate conditionals:
`autonomyService`, `browserService`, `skillSearch`

## Per-Skill Capability Audit

Capabilities inferred from reading each handler. Skills not listed here need no
privileged services (they only use universal services or no services at all).

### outboundGateway

| Skill | Capabilities |
|---|---|
| `email-send` | `outboundGateway` |
| `email-reply` | `outboundGateway` |
| `email-get` | `outboundGateway` |
| `email-list` | `outboundGateway` |
| `email-archive` | `outboundGateway` |
| `email-draft-save` | `outboundGateway` |
| `signal-send` | `outboundGateway` |

### heldMessages

| Skill | Capabilities |
|---|---|
| `held-messages-list` | `heldMessages` |
| `held-messages-process` | `heldMessages`, `outboundGateway` |

### schedulerService

| Skill | Capabilities |
|---|---|
| `scheduler-create` | `schedulerService` |
| `scheduler-list` | `schedulerService` |
| `scheduler-cancel` | `schedulerService` |
| `scheduler-report` | `schedulerService` |

### nylasCalendarClient

| Skill | Capabilities |
|---|---|
| `calendar-list-calendars` | `nylasCalendarClient` |
| `calendar-list-events` | `nylasCalendarClient` |
| `calendar-create-event` | `nylasCalendarClient` |
| `calendar-update-event` | `nylasCalendarClient` |
| `calendar-delete-event` | `nylasCalendarClient` |
| `calendar-check-conflicts` | `nylasCalendarClient` |
| `calendar-find-free-time` | `nylasCalendarClient` |
| `calendar-register` | `nylasCalendarClient`, `entityMemory` |

### entityMemory

| Skill | Capabilities |
|---|---|
| `extract-relationships` | `entityMemory` |
| `query-relationships` | `entityMemory` |
| `delete-relationship` | `entityMemory` |
| `extract-facts` | `entityMemory` |
| `context-for-email` | `entityMemory` |
| `entity-context` | `entityMemory` |
| `knowledge-meeting-links` | `entityMemory` |
| `knowledge-loyalty-programs` | `entityMemory` |
| `knowledge-travel-preferences` | `entityMemory` |
| `knowledge-company-overview` | `entityMemory` |
| `contact-create` | `entityMemory` |
| `contact-list` | `entityMemory` |
| `contact-lookup` | `entityMemory` |
| `contact-merge` | `entityMemory` |
| `contact-find-duplicates` | `entityMemory` |
| `contact-set-role` | `entityMemory` |
| `contact-link-identity` | `entityMemory` |
| `contact-unlink-identity` | `entityMemory` |
| `contact-grant-permission` | `entityMemory` |
| `contact-revoke-permission` | `entityMemory` |

### entityMemory + schedulerService

| Skill | Capabilities |
|---|---|
| `template-meeting-request` | `entityMemory`, `schedulerService` |
| `template-cancel` | `entityMemory`, `schedulerService` |
| `template-reschedule` | `entityMemory`, `schedulerService` |
| `template-doc-request` | `entityMemory` |

### bus / agentRegistry / bullpenService

| Skill | Capabilities |
|---|---|
| `delegate` | `bus`, `agentRegistry` |
| `bullpen` | `bus`, `bullpenService` |

### autonomyService / browserService / skillSearch

| Skill | Capabilities |
|---|---|
| `get-autonomy` | `autonomyService` |
| `set-autonomy` | `autonomyService` |
| `web-browser` | `browserService` |
| `skill-registry` | `skillSearch` |

### No capabilities needed

These skills currently have `infrastructure: true` but only use universal
services (`contactService`). They lose the flag and gain no capabilities entry:

- `contact-set-trust`
- `contact-rename`

## Implementation notes

**Verify each handler before finalising its capabilities.** The audit above was
inferred from handler code reading. Some skills — especially contact and
template skills — may access more services than identified. Under-declaring is a
runtime bug (skill silently loses access); over-declaring is a security issue.
Read each handler at implementation time to confirm.

**`entityContextAssembler` stays universal.** It is a read-only DB pipeline
injected unconditionally (execution.ts lines 357-363). The issue's original
registry included it as a privileged service for `entity-context`, but since
it's already universal with the same justification as `contactService`, it
remains outside the capabilities system.

**`contactService` stays universal.** Confirmed intentional — read-only contact
lookups are not a privilege escalation. Skills like `contact-set-trust` and
`contact-rename` that only use `contactService` need no capabilities entry.

**Error messages in handlers.** Many handlers have error messages referencing
`infrastructure: true` (e.g. "Is infrastructure: true set in the manifest?").
These should be updated to reference the specific capability (e.g. "Declare
'outboundGateway' in capabilities").

## Type changes

**`src/skills/types.ts`:**
- Remove `infrastructure?: boolean` from `SkillManifest`
- Add `capabilities?: string[]` to `SkillManifest`
- Update doc comments on `SkillContext` fields — replace "infrastructure skills"
  with "skills declaring the corresponding capability"

## Loader changes

**`src/skills/loader.ts`:**
- Add `VALID_CAPABILITIES` allowlist
- Validate `manifest.capabilities` entries against allowlist at load time
- `Object.freeze(manifest)` after validation and default-setting
- Remove any `infrastructure` defaulting logic

## Test changes

**`src/skills/execution.test.ts` — new test cases:**
1. A skill declaring `['outboundGateway']` receives `ctx.outboundGateway` but
   not `ctx.bus`, `ctx.entityMemory`, etc.
2. A skill with no `capabilities` field receives no privileged services (only
   universal ones)
3. A skill declaring `['schedulerService']` when ExecutionLayer has no
   schedulerService wired returns a clean skill error

**Loader tests (new or in existing test file):**
1. Unknown capability name causes load failure
2. Valid capabilities load successfully and manifest is frozen
3. Frozen manifest cannot be mutated at runtime

Existing execution tests don't set `infrastructure: true` on their manifests, so
they should pass without changes.

## Documentation updates

**`docs/dev/adding-a-skill.md`:**
- Replace the `infrastructure` field reference (line 112-114) with a
  `capabilities` field reference: valid names, when to use each, examples
- Update the `SkillContext` example (lines 239-266) — replace
  "Infrastructure-only fields" grouping with "Capability-gated fields"
- Add `capabilities` to the PR checklist

**`docs/specs/03-skills-and-execution.md`:**
- Update the "Privilege access" paragraph (line 42) — skills now declare
  `capabilities` in their manifest (per-capability, validated at load, frozen
  after load)
- Update the implementation status entry (line 222) — mark privilege scoping as
  Done, remove reference to pending `capabilities.ts` registry

## Migration

All 50 skill.json files are updated atomically in the same PR:
- Remove `"infrastructure": true`
- Add `"capabilities": [...]` with the per-skill list from the audit above

Two skills (`contact-set-trust`, `contact-rename`) lose `infrastructure: true`
and gain nothing — they only use universal services.

## Versioning

Patch bump (`0.0.X`) — pre-alpha, breaking changes expected.

Changelog entry under **Security** (eliminates over-broad privilege grant) and
**Changed** (manifest schema: `infrastructure` replaced by `capabilities`).

## Checklist

- [ ] Add `capabilities?: string[]` to `SkillManifest` in `src/skills/types.ts`
- [ ] Remove `infrastructure?: boolean` from `SkillManifest`
- [ ] Add `VALID_CAPABILITIES` allowlist and validation to `src/skills/loader.ts`
- [ ] Add `Object.freeze(manifest)` to loader after validation
- [ ] Replace `if (manifest.infrastructure)` block in `src/skills/execution.ts`
      with capabilities loop
- [ ] Remove the 3 name-gated conditionals (autonomyService, browserService,
      skillSearch) — folded into capabilities loop
- [ ] Update all 50 `skill.json` files: remove `infrastructure`, add
      `capabilities`
- [ ] Update handler error messages referencing `infrastructure: true`
- [ ] Update `docs/dev/adding-a-skill.md`
- [ ] Update `docs/specs/03-skills-and-execution.md`
- [ ] Add execution.test.ts tests for capability injection
- [ ] Add loader tests for validation and freeze
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] Bump version, update CHANGELOG.md
