# Design: `config/local.yaml` Override Support

**Date:** 2026-04-11
**Status:** Approved
**Issue:** N/A (deployment hygiene)

---

## Problem

`config/default.yaml` is committed to the `curia` repo. Deployment-specific config — primarily `channel_accounts.email`, which names which email accounts exist and their outbound policies — has no safe home. The values themselves use `env:VAR_NAME` references (so no secrets are committed), but the structural config (account names, policies) varies per deployment and shouldn't live in the upstream repo.

The existing approach is to leave the `channel_accounts` block commented out in `default.yaml`, which means multi-account email can't be used without editing the upstream config file.

---

## Solution

Support an optional `config/local.yaml` file that is:

- Loaded after `default.yaml`
- Deep-merged on top of it (local wins on all conflicts)
- **Gitignored** in the `curia` repo — never committed there
- Provided by deployment repos (e.g. `curia-deploy`) and installed to the VPS at deploy time

This gives deployments a clean place to add structural config without forking `default.yaml` or touching the upstream repo.

---

## Architecture

### Load order

```
config/default.yaml   ← always loaded, committed to curia repo
       +
config/local.yaml     ← optional, gitignored, provided by deployment repo
       ↓
merged YamlConfig     ← passed to existing validation and resolution logic
```

### Deep merge semantics

- **Objects** are merged recursively. A key in `local.yaml` that is an object is merged into the corresponding object in `default.yaml`, not replaced wholesale.
- **Scalars and arrays** in `local.yaml` replace their counterparts in `default.yaml`. Arrays are not concatenated.
- A key present only in `local.yaml` is added to the result. A key present only in `default.yaml` is preserved unchanged.

**Example:** Given `default.yaml`:

```yaml
channels:
  cli:
    enabled: true
dispatch:
  conversationCheckpointDebounceMs: 600000
```

And `local.yaml`:

```yaml
channel_accounts:
  email:
    curia:
      nylas_grant_id: "env:NYLAS_GRANT_ID"
      self_email:     "env:NYLAS_SELF_EMAIL"
      outbound_policy: direct
    joseph:
      nylas_grant_id: "env:NYLAS_GRANT_ID_JOSEPH"
      self_email:     "env:NYLAS_SELF_EMAIL_JOSEPH"
      outbound_policy: autonomy_gated
      autonomy_threshold: 80
```

The merged result contains all keys from both files. `channels` and `dispatch` are unchanged; `channel_accounts` is added from local.

### Merge function

A standalone `deepMerge(base, override)` utility in `config.ts`. Both arguments are plain objects parsed from YAML. Returns a new object — does not mutate either input. Array replacement (not concatenation) is intentional: config arrays (e.g. `extra_injection_patterns`) are meant to be self-contained lists, not additive.

### Validation timing

The merge happens **before** validation. The merged `YamlConfig` object is passed through the existing `validateYamlConfig()` call unchanged. This means `local.yaml` additions (like `channel_accounts`) are fully validated at startup.

### File not found

If `config/local.yaml` does not exist, startup proceeds with `default.yaml` alone. Missing file is not logged (expected in local dev and CI). An unreadable or unparseable `local.yaml` is a hard startup error — same behaviour as a broken `default.yaml`.

---

## Changes to `curia`

### `src/config.ts`

1. Add `deepMerge(base, override)` utility function (pure, no side effects).
2. In `loadYamlConfig()` (or equivalent), after parsing `default.yaml`, check for `config/local.yaml`. If it exists, parse it and deep-merge it on top. Pass the merged result to `validateYamlConfig()`.
3. No changes to the `YamlConfig` interface, validation logic, or `resolveChannelAccounts()`.

### `config/.gitignore` (or root `.gitignore`)

Add `config/local.yaml` to ensure it is never accidentally committed.

### `docs/dev/configuration.md`

New section: **`config/local.yaml` — deployment overrides**

- What it is and why it exists
- Deep merge semantics
- The relationship to `default.yaml` (additive, local wins on conflicts)
- That it is gitignored and should never be committed to `curia`
- The primary use case: `channel_accounts.email` for multi-account email in a specific deployment
- A worked example showing a two-account `channel_accounts.email` block

### `docs/dev/setup.md`

Brief addition to the Nylas section: note that `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` are the single-account legacy path, and link to the `channel_accounts.email` section in `configuration.md` for multi-account setup using `local.yaml`.

---

## What is NOT changing

- `config/default.yaml` — the `channel_accounts` example comment block remains as-is (documentation). The actual block stays commented out.
- `YamlConfig` interface — no new fields; `channel_accounts` is already defined.
- `resolveChannelAccounts()` — no changes.
- `validateYamlConfig()` — no changes.
- The `curia-deploy` repo — covered in the follow-on task (wiring up `custom.yaml` and `deploy.sh` changes).

---

## Testing

- Unit tests for `deepMerge()`: empty inputs, non-overlapping keys, scalar override, nested object merge, array replacement, null/undefined handling.
- Update existing `loadConfig` / `loadYamlConfig` unit tests to cover: `local.yaml` absent (no change to behaviour), `local.yaml` present and merged, `local.yaml` parse error exits.
- The existing channel_accounts validation tests exercise the merged result path already; no new validation tests needed.

---

## Out of scope

- Hot reload of `local.yaml` at runtime (restart required, same as `default.yaml`)
- Supporting multiple override files or environment-specific overrides (YAGNI)
- `curia-deploy` changes (follow-on task)
