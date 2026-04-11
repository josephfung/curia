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
