import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig } from './config.js';
import { SensitivityClassifier } from './memory/sensitivity.js';

function writeTempConfigDir(opts: { defaultYaml?: string; localYaml?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-sensitivity-cfg-'));
  if (opts.defaultYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'default.yaml'), opts.defaultYaml);
  }
  if (opts.localYaml !== undefined) {
    fs.writeFileSync(path.join(dir, 'local.yaml'), opts.localYaml);
  }
  return dir;
}

// sensitivity_rules governs KG bulk-export gating, so — unlike most other config
// blocks — it must be both operator-overridable via local.yaml AND validated in the
// merged-config pass (#1369). These tests cover both requirements plus the
// end-to-end path: merged config → SensitivityClassifier actually reflects it.
describe('loadYamlConfig: sensitivity_rules block', () => {
  it('parses and normalizes a valid sensitivity_rules block from default.yaml', () => {
    const dir = writeTempConfigDir({
      defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - "  Revenue  "
      - BUDGET
`,
    });
    const config = loadYamlConfig(dir);
    expect(config.sensitivity_rules).toEqual([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue', 'budget'] },
    ]);
  });

  describe('local.yaml override takes effect (#1369 AC 1)', () => {
    it('local.yaml sensitivity_rules replaces default.yaml sensitivity_rules', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - revenue
`,
        localYaml: `
sensitivity_rules:
  - category: custom
    sensitivity: restricted
    patterns:
      - proprietary formula
`,
      });
      const config = loadYamlConfig(dir);
      expect(config.sensitivity_rules).toEqual([
        { category: 'custom', sensitivity: 'restricted', patterns: ['proprietary formula'] },
      ]);
    });

    it('a rule added only in local.yaml is honored by the classifier built from merged config', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - revenue
`,
        localYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - revenue
  - category: industry_secret
    sensitivity: restricted
    patterns:
      - proprietary formula
`,
      });
      const config = loadYamlConfig(dir);
      const classifier = SensitivityClassifier.fromRules(config.sensitivity_rules ?? []);

      // The rule that only exists in local.yaml is applied — this is exactly the
      // scenario that was silently broken before #1369: an operator adding a
      // custom category via local.yaml believed it was protected but it had no effect.
      expect(classifier.classify('our proprietary formula for widget X', {})).toBe('restricted');
      expect(classifier.classify('Q3 revenue forecast', {})).toBe('confidential');
    });
  });

  describe('validation rejects malformed overrides (#1369 AC 2)', () => {
    it('rejects a non-array sensitivity_rules', () => {
      const dir = writeTempConfigDir({ defaultYaml: `sensitivity_rules:\n  foo: bar\n` });
      expect(() => loadYamlConfig(dir)).toThrow('sensitivity_rules must be an array');
    });

    it('rejects a rule missing category', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - sensitivity: confidential
    patterns:
      - revenue
`,
      });
      expect(() => loadYamlConfig(dir)).toThrow("sensitivity_rules[0]: missing 'category'");
    });

    it('rejects an unknown sensitivity level', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: top-secret
    patterns:
      - revenue
`,
      });
      expect(() => loadYamlConfig(dir)).toThrow("unknown sensitivity 'top-secret'");
    });

    it('rejects an empty patterns array', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns: []
`,
      });
      expect(() => loadYamlConfig(dir)).toThrow("'patterns' must be a non-empty array");
    });

    it('rejects a blank pattern', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - "   "
`,
      });
      expect(() => loadYamlConfig(dir)).toThrow('patterns must not contain empty values');
    });

    it('a malformed override in local.yaml alone (default.yaml valid) still fails startup', () => {
      const dir = writeTempConfigDir({
        defaultYaml: `
sensitivity_rules:
  - category: financial
    sensitivity: confidential
    patterns:
      - revenue
`,
        localYaml: `
sensitivity_rules:
  - category: custom
    sensitivity: extremely-restricted
    patterns:
      - secret
`,
      });
      expect(() => loadYamlConfig(dir)).toThrow("unknown sensitivity 'extremely-restricted'");
    });
  });

  it('leaves sensitivity_rules undefined when absent from both files', () => {
    const dir = writeTempConfigDir({ defaultYaml: `channels:\n  cli:\n    enabled: true\n` });
    const config = loadYamlConfig(dir);
    expect(config.sensitivity_rules).toBeUndefined();
  });
});
