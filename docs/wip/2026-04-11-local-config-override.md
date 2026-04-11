# Local Config Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `config/local.yaml` support to Curia so deployment-specific config (e.g. `channel_accounts.email`) can live in a deployment repo rather than in the upstream `curia` repo.

**Architecture:** `loadYamlConfig()` in `src/config.ts` is restructured to parse `default.yaml` and `local.yaml` in separate try/catch blocks, deep-merging the results before running all existing validation. A standalone `deepMerge()` utility handles recursive object merging. `local.yaml` is already gitignored.

**Tech Stack:** TypeScript, `js-yaml`, `node:fs`, Vitest

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config/`

---

## File map

| File | Action | What changes |
|---|---|---|
| `src/config.ts` | Modify | Add `deepMerge()`, restructure `loadYamlConfig()` to load+merge `local.yaml` before validation |
| `src/config.local-yaml.test.ts` | Create | Tests for `deepMerge()` and `local.yaml` load/merge/error behaviour |
| `docs/dev/configuration.md` | Modify | New `config/local.yaml` section with merge semantics and worked example |
| `docs/dev/setup.md` | Modify | Add multi-account link to end of Nylas subsection |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |
| `package.json` | Modify | Patch version bump |

---

## Task 1: Add `deepMerge` and wire `local.yaml` into `loadYamlConfig`

**Files:**
- Modify: `src/config.ts`
- Create: `src/config.local-yaml.test.ts`

### Background

`loadYamlConfig(configDir)` currently wraps everything in a single try/catch:
the `readFileSync` of `default.yaml`, the root-type check, and all the
validation. The ENOENT catch at the bottom returns `{}` for absent files.

The restructuring splits this into two separate try/catch blocks — one for
`default.yaml`, one for `local.yaml` — so each gets its own clear error
message. All existing validation runs after the merge, on the combined object.

- [ ] **Step 1: Write failing tests for `deepMerge`**

Create `src/config.local-yaml.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig } from './config.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Write a config dir with default.yaml and optionally local.yaml. */
function writeTempConfigDir(opts: {
  defaultYaml?: string;
  localYaml?: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-local-cfg-'));
  if (opts.defaultYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'default.yaml'), opts.defaultYaml);
  }
  if (opts.localYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'local.yaml'), opts.localYaml);
  }
  return dir;
}

// ── local.yaml absent (baseline — existing behaviour unchanged) ───────────────

describe('loadYamlConfig — local.yaml absent', () => {
  it('returns empty object when neither file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-local-cfg-'));
    expect(loadYamlConfig(dir)).toEqual({});
  });

  it('returns default.yaml config when local.yaml is absent', () => {
    const dir = writeTempConfigDir({
      defaultYaml: 'skillOutput:\n  maxLength: 50000\n',
    });
    const config = loadYamlConfig(dir);
    expect(config.skillOutput?.maxLength).toBe(50000);
  });
});

// ── local.yaml present ────────────────────────────────────────────────────────

describe('loadYamlConfig — local.yaml merge', () => {
  it('adds keys from local.yaml that are absent from default.yaml', () => {
    const dir = writeTempConfigDir({
      defaultYaml: 'skillOutput:\n  maxLength: 50000\n',
      localYaml: `
channel_accounts:
  email:
    curia:
      nylas_grant_id: literal-grant-id
      self_email: curia@example.com
      outbound_policy: direct
`,
    });
    const config = loadYamlConfig(dir);
    expect(config.skillOutput?.maxLength).toBe(50000);
    expect(config.channel_accounts?.email?.['curia']?.self_email).toBe('curia@example.com');
  });

  it('local.yaml scalar overrides default.yaml scalar', () => {
    const dir = writeTempConfigDir({
      defaultYaml: 'skillOutput:\n  maxLength: 50000\n',
      localYaml: 'skillOutput:\n  maxLength: 99999\n',
    });
    const config = loadYamlConfig(dir);
    expect(config.skillOutput?.maxLength).toBe(99999);
  });

  it('merges nested objects rather than replacing the parent', () => {
    const dir = writeTempConfigDir({
      defaultYaml: `
dispatch:
  conversationCheckpointDebounceMs: 600000
  rate_limit:
    window_ms: 60000
    max_per_sender: 15
    max_global: 100
`,
      localYaml: `
dispatch:
  rate_limit:
    max_per_sender: 5
`,
    });
    const config = loadYamlConfig(dir);
    // From default.yaml (unchanged)
    expect(config.dispatch?.conversationCheckpointDebounceMs).toBe(600000);
    expect(config.dispatch?.rate_limit?.window_ms).toBe(60000);
    expect(config.dispatch?.rate_limit?.max_global).toBe(100);
    // Overridden by local.yaml
    expect(config.dispatch?.rate_limit?.max_per_sender).toBe(5);
  });

  it('local.yaml array replaces default.yaml array entirely', () => {
    const dir = writeTempConfigDir({
      defaultYaml: `
security:
  extra_injection_patterns:
    - regex: "foo"
      label: foo
`,
      localYaml: `
security:
  extra_injection_patterns:
    - regex: "bar"
      label: bar
    - regex: "baz"
      label: baz
`,
    });
    const config = loadYamlConfig(dir);
    expect(config.security?.extra_injection_patterns).toHaveLength(2);
    expect(config.security?.extra_injection_patterns?.[0]?.label).toBe('bar');
  });

  it('empty local.yaml is treated as no override', () => {
    const dir = writeTempConfigDir({
      defaultYaml: 'skillOutput:\n  maxLength: 50000\n',
      localYaml: '',
    });
    const config = loadYamlConfig(dir);
    expect(config.skillOutput?.maxLength).toBe(50000);
  });

  it('merged config is still validated — invalid local.yaml value throws', () => {
    const dir = writeTempConfigDir({
      defaultYaml: '',
      localYaml: 'skillOutput:\n  maxLength: -1\n',
    });
    expect(() => loadYamlConfig(dir)).toThrow('skillOutput.maxLength');
  });
});

// ── local.yaml error cases ────────────────────────────────────────────────────

describe('loadYamlConfig — local.yaml errors', () => {
  it('throws with local.yaml in the message when local.yaml has a YAML syntax error', () => {
    const dir = writeTempConfigDir({
      defaultYaml: '',
      localYaml: 'key: [unclosed bracket\n',
    });
    expect(() => loadYamlConfig(dir)).toThrow('config/local.yaml');
  });

  it('throws when local.yaml root is not a mapping (e.g. a scalar)', () => {
    const dir = writeTempConfigDir({
      defaultYaml: '',
      localYaml: 'just a string\n',
    });
    expect(() => loadYamlConfig(dir)).toThrow('config/local.yaml must contain a YAML mapping');
  });

  it('throws when local.yaml root is a sequence', () => {
    const dir = writeTempConfigDir({
      defaultYaml: '',
      localYaml: '- item1\n- item2\n',
    });
    expect(() => loadYamlConfig(dir)).toThrow('config/local.yaml must contain a YAML mapping');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they all fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config test -- --reporter=verbose src/config.local-yaml.test.ts
```

Expected: all tests fail with "loadYamlConfig is not a function" or similar (the tests import a function that doesn't exist yet, or `local.yaml` merging is absent).

- [ ] **Step 3: Add `deepMerge` and restructure `loadYamlConfig` in `src/config.ts`**

Add `deepMerge` immediately before `loadYamlConfig` (around line 210). Then restructure `loadYamlConfig` itself.

**Add this function before `loadYamlConfig`:**

```typescript
/**
 * Recursively merge two plain objects. `override` wins on all scalar and
 * array conflicts; nested plain objects are merged recursively.
 *
 * Neither input is mutated — a new object is always returned.
 * Arrays are replaced, not concatenated: config arrays (e.g.
 * extra_injection_patterns) are self-contained lists, not additive.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideVal] of Object.entries(override)) {
    const baseVal = result[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      // Both sides are plain objects — merge recursively.
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      // Scalar, array, or type mismatch — override wins outright.
      result[key] = overrideVal;
    }
  }
  return result;
}
```

**Replace the entire `loadYamlConfig` function** (from the `export function loadYamlConfig` line through its closing `}`) with:

```typescript
/**
 * Load and parse config/default.yaml, then deep-merge config/local.yaml on
 * top if it exists. local.yaml is gitignored in this repo and supplied by
 * deployment repos (e.g. curia-deploy) at deploy time.
 *
 * @param configDir - Absolute path to the directory containing default.yaml.
 *   Pass `path.resolve(import.meta.dirname, '../config')` from index.ts.
 * @returns Merged and validated YAML config, or an empty object if
 *   default.yaml is absent (test/CI environments).
 * @throws If either file exists but cannot be parsed, or if the merged config
 *   fails validation — a broken config should cause a loud startup failure,
 *   not silently apply wrong defaults.
 */
export function loadYamlConfig(configDir: string): YamlConfig {
  // ── Step 1: parse default.yaml ──────────────────────────────────────────
  // ENOENT → empty config (test/CI environments where the file is absent).
  // Any other error → hard startup failure.
  let base: Record<string, unknown>;
  try {
    const parsed = yaml.load(readFileSync(path.join(configDir, 'default.yaml'), 'utf-8'));
    if (parsed == null) {
      base = {};
    } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config/default.yaml must contain a YAML mapping at the root');
    } else {
      base = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(
      `Failed to load config/default.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 2: merge config/local.yaml if present ──────────────────────────
  // local.yaml is gitignored and provided by deployment repos at deploy time.
  // ENOENT → silently skip (expected in dev, CI, and non-deployment envs).
  // Any other error → hard startup failure.
  const localPath = path.join(configDir, 'local.yaml');
  try {
    const localParsed = yaml.load(readFileSync(localPath, 'utf-8'));
    if (localParsed !== null) {
      if (typeof localParsed !== 'object' || Array.isArray(localParsed)) {
        throw new Error('config/local.yaml must contain a YAML mapping at the root');
      }
      base = deepMerge(base, localParsed as Record<string, unknown>);
    }
    // localParsed === null means the file was empty — treat as no override.
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // local.yaml absent — proceed with default.yaml only.
    } else {
      throw new Error(
        `Failed to load config/local.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Step 3: validate the merged config ──────────────────────────────────
  // All validation below is identical to the original — it now runs on the
  // merged object so local.yaml additions are subject to the same checks.
  const config = base as YamlConfig;

  // Validate skillOutput.maxLength if present — a non-positive or non-integer value
  // would silently distort truncation behavior (e.g., negative would truncate to zero,
  // a float would be misinterpreted by slice()).
  const maxLength = config.skillOutput?.maxLength;
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength <= 0)) {
    throw new Error(`skillOutput.maxLength must be a positive integer, got: ${maxLength}`);
  }

  const checkpointDebounceMs = config.dispatch?.conversationCheckpointDebounceMs;
  if (checkpointDebounceMs !== undefined && (!Number.isInteger(checkpointDebounceMs) || checkpointDebounceMs <= 0)) {
    throw new Error(
      `dispatch.conversationCheckpointDebounceMs must be a positive integer, got: ${checkpointDebounceMs}`,
    );
  }

  const rateLimit = config.dispatch?.rate_limit;
  if (rateLimit !== undefined) {
    const { window_ms, max_per_sender, max_global } = rateLimit;
    if (window_ms !== undefined && (!Number.isInteger(window_ms) || window_ms <= 0)) {
      throw new Error(`dispatch.rate_limit.window_ms must be a positive integer, got: ${window_ms}`);
    }
    if (max_per_sender !== undefined && (!Number.isInteger(max_per_sender) || max_per_sender <= 0)) {
      throw new Error(`dispatch.rate_limit.max_per_sender must be a positive integer, got: ${max_per_sender}`);
    }
    if (max_global !== undefined && (!Number.isInteger(max_global) || max_global <= 0)) {
      throw new Error(`dispatch.rate_limit.max_global must be a positive integer, got: ${max_global}`);
    }
    // Cross-validate: global must be at least as large as per-sender, otherwise no single
    // sender can ever reach their per-sender quota — the global becomes the effective ceiling
    // for everyone, making per-sender meaningless. This is almost certainly a misconfiguration.
    // Uses effective values (same defaults as index.ts) so a partial config is also caught.
    const effectiveMaxPerSender = max_per_sender ?? 15;
    const effectiveMaxGlobal = max_global ?? 100;
    if (effectiveMaxGlobal < effectiveMaxPerSender) {
      throw new Error(
        `dispatch.rate_limit.max_global (${effectiveMaxGlobal}) must be >= max_per_sender (${effectiveMaxPerSender})`,
      );
    }
  }

  if (config.workingMemory?.summarization !== undefined) {
    const summarizationThreshold = config.workingMemory.summarization.threshold;
    if (summarizationThreshold !== undefined && (!Number.isInteger(summarizationThreshold) || summarizationThreshold < 2)) {
      throw new Error(`workingMemory.summarization.threshold must be an integer >= 2, got: ${summarizationThreshold}`);
    }

    const summarizationKeepWindow = config.workingMemory.summarization.keepWindow;
    if (summarizationKeepWindow !== undefined && (!Number.isInteger(summarizationKeepWindow) || summarizationKeepWindow < 1)) {
      throw new Error(`workingMemory.summarization.keepWindow must be a positive integer, got: ${summarizationKeepWindow}`);
    }

    // Cross-validate using effective values (same defaults as index.ts bootstrap) so a
    // config like { keepWindow: 25 } (no explicit threshold) is caught here rather than
    // silently passing validation and failing at runtime.
    const effectiveThreshold = summarizationThreshold ?? 20;
    const effectiveKeepWindow = summarizationKeepWindow ?? 10;
    if (effectiveKeepWindow >= effectiveThreshold) {
      throw new Error(
        `workingMemory.summarization.keepWindow (${effectiveKeepWindow}) must be less than threshold (${effectiveThreshold})`,
      );
    }
  }

  // Validate channel_accounts if present
  const channelAccounts = config.channel_accounts?.email;
  if (channelAccounts !== undefined) {
    if (channelAccounts === null || typeof channelAccounts !== 'object' || Array.isArray(channelAccounts)) {
      throw new Error('channel_accounts.email must be a YAML mapping');
    }
    const validPolicies: OutboundPolicy[] = ['direct', 'draft_gate', 'autonomy_gated'];
    for (const [accountName, rawAccount] of Object.entries(channelAccounts)) {
      if (typeof rawAccount !== 'object' || rawAccount === null || Array.isArray(rawAccount)) {
        throw new Error(`channel_accounts.email.${accountName} must be a YAML mapping`);
      }
      if (typeof rawAccount.nylas_grant_id !== 'string' || !rawAccount.nylas_grant_id) {
        throw new Error(`channel_accounts.email.${accountName}.nylas_grant_id must be a non-empty string`);
      }
      if (typeof rawAccount.self_email !== 'string' || !rawAccount.self_email) {
        throw new Error(`channel_accounts.email.${accountName}.self_email must be a non-empty string`);
      }
      if (!validPolicies.includes(rawAccount.outbound_policy)) {
        throw new Error(
          `channel_accounts.email.${accountName}.outbound_policy must be one of: ${validPolicies.join(', ')}, got: "${rawAccount.outbound_policy}"`,
        );
      }
      if (rawAccount.outbound_policy === 'autonomy_gated') {
        if (rawAccount.autonomy_threshold === undefined) {
          throw new Error(
            `channel_accounts.email.${accountName}: outbound_policy 'autonomy_gated' requires autonomy_threshold`,
          );
        }
        if (!Number.isInteger(rawAccount.autonomy_threshold) || rawAccount.autonomy_threshold < 0 || rawAccount.autonomy_threshold > 100) {
          throw new Error(
            `channel_accounts.email.${accountName}.autonomy_threshold must be an integer 0–100, got: ${rawAccount.autonomy_threshold}`,
          );
        }
      }
      if (rawAccount.autonomy_threshold !== undefined && rawAccount.outbound_policy !== 'autonomy_gated') {
        throw new Error(
          `channel_accounts.email.${accountName}: autonomy_threshold is only valid when outbound_policy is 'autonomy_gated'`,
        );
      }
    }
  }

  const drift = config.intentDrift;
  if (drift !== undefined) {
    // Reject non-object roots (e.g. `intentDrift: false`, `intentDrift: "off"`, `intentDrift: []`).
    // Without this check, those values would pass the leaf validations below, then reach
    // index.ts where `yamlConfig.intentDrift?.enabled !== false` evaluates truthy-by-default,
    // silently enabling drift detection despite a clearly invalid config.
    if (typeof drift !== 'object' || drift === null || Array.isArray(drift)) {
      throw new Error('intentDrift must be a YAML mapping');
    }
    if (drift.enabled !== undefined && typeof drift.enabled !== 'boolean') {
      throw new Error(`intentDrift.enabled must be a boolean, got: ${String(drift.enabled)}`);
    }
    if (drift.checkEveryNBursts !== undefined) {
      if (!Number.isInteger(drift.checkEveryNBursts) || drift.checkEveryNBursts < 1) {
        throw new Error(
          `intentDrift.checkEveryNBursts must be a positive integer, got: ${drift.checkEveryNBursts}`,
        );
      }
    }
    const validConfidences = ['high', 'medium', 'low'];
    if (
      drift.minConfidenceToPause !== undefined &&
      !validConfidences.includes(drift.minConfidenceToPause)
    ) {
      throw new Error(
        `intentDrift.minConfidenceToPause must be one of: ${validConfidences.join(', ')}, got: "${drift.minConfidenceToPause}"`,
      );
    }
  }

  const dreaming = config.dreaming;
  if (dreaming !== undefined) {
    if (typeof dreaming !== 'object' || dreaming === null || Array.isArray(dreaming)) {
      throw new Error('dreaming must be a YAML mapping');
    }
    const decay = dreaming.decay;
    if (decay !== undefined) {
      if (typeof decay !== 'object' || decay === null || Array.isArray(decay)) {
        throw new Error('dreaming.decay must be a YAML mapping');
      }
      if (decay.intervalMs !== undefined && (!Number.isInteger(decay.intervalMs) || decay.intervalMs <= 0)) {
        throw new Error(`dreaming.decay.intervalMs must be a positive integer, got: ${decay.intervalMs}`);
      }
      if (decay.archiveThreshold !== undefined && (typeof decay.archiveThreshold !== 'number' || decay.archiveThreshold < 0 || decay.archiveThreshold > 1)) {
        throw new Error(`dreaming.decay.archiveThreshold must be a number between 0 and 1, got: ${decay.archiveThreshold}`);
      }
      const halfLifeDays = decay.halfLifeDays;
      if (halfLifeDays !== undefined) {
        if (typeof halfLifeDays !== 'object' || halfLifeDays === null || Array.isArray(halfLifeDays)) {
          throw new Error('dreaming.decay.halfLifeDays must be a YAML mapping');
        }
        for (const key of ['slow_decay', 'fast_decay'] as const) {
          const val = halfLifeDays[key];
          if (val !== undefined && (!Number.isInteger(val) || val <= 0)) {
            throw new Error(`dreaming.decay.halfLifeDays.${key} must be a positive integer, got: ${val}`);
          }
        }
        // permanent must be null (meaning it never decays) — any non-null value
        // would be silently ignored by the decay engine, which only loops over
        // slow_decay and fast_decay, making a non-null permanent a misconfiguration.
        if (halfLifeDays.permanent !== undefined && halfLifeDays.permanent !== null) {
          throw new Error(`dreaming.decay.halfLifeDays.permanent must be null (permanent nodes never decay), got: ${String(halfLifeDays.permanent)}`);
        }
      }
    }
  }

  return config;
}
```

- [ ] **Step 4: Run the new tests and confirm they all pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config test -- --reporter=verbose src/config.local-yaml.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to confirm nothing regressed**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config test
```

Expected: all tests pass. The existing `config.dreaming.test.ts` tests (which call `loadYamlConfig` with only `default.yaml` in the temp dir) should still pass because `local.yaml` absent is a no-op.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config add src/config.ts src/config.local-yaml.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config commit -m "feat: add config/local.yaml deep-merge support"
```

---

## Task 2: Update documentation

**Files:**
- Modify: `docs/dev/configuration.md`
- Modify: `docs/dev/setup.md`

- [ ] **Step 1: Add `config/local.yaml` section to `configuration.md`**

Insert this new section between `## config/default.yaml — full reference` block and `## config/skills.yaml — MCP servers`. Find the heading `## \`config/skills.yaml\` — MCP servers` and insert directly before it:

```markdown
---

## `config/local.yaml` — deployment overrides

`config/local.yaml` is an optional file that, when present, is deep-merged on
top of `default.yaml` at startup. It exists so deployment-specific config can
live in a deployment repo (e.g. `curia-deploy`) rather than in the `curia`
repo itself.

**`config/local.yaml` is gitignored** — it is never committed to the `curia`
repo. Your deployment tooling writes it to the server at deploy time.

### Merge semantics

- **Objects** are merged recursively. A key in `local.yaml` that is a YAML
  mapping is merged into the corresponding mapping in `default.yaml` — only
  the keys you specify are overridden.
- **Scalars and arrays** in `local.yaml` replace the corresponding value in
  `default.yaml`. Arrays are not concatenated — the local value wins wholesale.
- A key present only in `local.yaml` is added. A key present only in
  `default.yaml` is preserved unchanged.

### Primary use case: multi-account email

The most common reason to use `local.yaml` is to configure
`channel_accounts.email`, which defines the named email accounts Curia manages
and their outbound policies. Because this structure varies per deployment, it
belongs in `local.yaml` rather than `default.yaml`.

Example `local.yaml` for a two-account deployment:

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

The `env:VAR_NAME` references are resolved from environment variables at
startup — no credentials are stored in `local.yaml`. The actual grant IDs and
email addresses live in `.env`.

For a full description of the `channel_accounts.email` schema and outbound
policy options, see the `channel_accounts` comment block in
`config/default.yaml`.

### Error handling

| Situation | Behaviour |
|---|---|
| `local.yaml` absent | Silently ignored — `default.yaml` is used alone |
| `local.yaml` present but empty | Treated as no override |
| `local.yaml` has a YAML syntax error | Hard startup failure with `Failed to load config/local.yaml: ...` |
| `local.yaml` root is not a mapping | Hard startup failure: `config/local.yaml must contain a YAML mapping at the root` |
| Merged value fails validation | Hard startup failure — same messages as a bad `default.yaml` value |

```

- [ ] **Step 2: Add multi-account link to `setup.md` Nylas section**

Find the paragraph in `docs/dev/setup.md` that ends with:

```
Restart Curia (`pnpm local`) — the email channel activates automatically when all three Nylas vars are present.
```

Append this paragraph directly after it (before the `### OpenAI (Embeddings)` heading):

```markdown
> **Multiple email accounts:** The three vars above wire up a single "legacy" email account. To configure multiple named accounts with per-account outbound policies (e.g. a Curia account that sends directly and a personal account that requires your approval), use `channel_accounts.email` in `config/local.yaml`. See [configuration.md](configuration.md#configlocalyaml--deployment-overrides) for details and an example.
```

- [ ] **Step 3: Run the full test suite to confirm docs changes didn't break anything**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config add docs/dev/configuration.md docs/dev/setup.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config commit -m "docs: document config/local.yaml override support"
```

---

## Task 3: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add CHANGELOG entry**

In `CHANGELOG.md`, find the `## [Unreleased]` section and add under **Added**:

```markdown
- **`config/local.yaml` override support** — optional deployment-specific YAML file deep-merged on top of `default.yaml` at startup; gitignored in this repo, supplied by deployment repos (e.g. `curia-deploy`) at deploy time. Primary use case: `channel_accounts.email` for multi-account email without touching the upstream config.
```

- [ ] **Step 2: Bump version in `package.json`**

Check the current version first:

```bash
grep '"version"' /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config/package.json
```

Apply a **patch** bump (this adds infrastructure, not a new user-facing capability).
For example, if the current version is `0.16.4`, change it to `0.16.5`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-local-config commit -m "chore: bump version to 0.16.x, update CHANGELOG for local.yaml support"
```

---

## Self-review

**Spec coverage:**
- `deepMerge` utility → Task 1 (embedded in config.ts, tested in config.local-yaml.test.ts) ✓
- `local.yaml` absent → no-op ✓ (Task 1, test: "returns default.yaml config when local.yaml is absent")
- `local.yaml` present + merged → Task 1, multiple tests ✓
- `local.yaml` parse error → hard failure ✓ (Task 1, error-case tests)
- Validation runs on merged result ✓ (Task 1, test: "merged config is still validated")
- `local.yaml` gitignored → already in `.gitignore`, no code change needed ✓
- `docs/dev/configuration.md` new section → Task 2 ✓
- `docs/dev/setup.md` multi-account link → Task 2 ✓
- CHANGELOG + version → Task 3 ✓

**Placeholder scan:** No TBDs, no "similar to above", all code is complete.

**Type consistency:** `deepMerge` takes and returns `Record<string, unknown>`. The cast to `YamlConfig` at the end of `loadYamlConfig` is the same as the original. All validation references `config.*` which is the merged result — consistent throughout.
