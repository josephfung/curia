// config.relay-budget.test.ts — autonomy.relay_budget resolution and validation (#1320).
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveRelayBudgetConfig } from '../../src/config.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-relay-budget-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveRelayBudgetConfig (#1320)', () => {
  it('defaults to 3 per hour', () => {
    expect(resolveRelayBudgetConfig(undefined)).toEqual({ perHour: 3 });
    expect(resolveRelayBudgetConfig({})).toEqual({ perHour: 3 });
  });

  it('reads per_hour, including 0 (off)', () => {
    expect(resolveRelayBudgetConfig({ relay_budget: { per_hour: 5 } })).toEqual({ perHour: 5 });
    expect(resolveRelayBudgetConfig({ relay_budget: { per_hour: 0 } })).toEqual({ perHour: 0 });
  });
});

describe('loadYamlConfig — autonomy.relay_budget validation (#1320)', () => {
  it('accepts a non-negative integer', () => {
    const cfg = loadYamlConfig(writeConfig('autonomy:\n  relay_budget:\n    per_hour: 4\n'));
    expect(resolveRelayBudgetConfig(cfg.autonomy)).toEqual({ perHour: 4 });
  });

  it.each(['-1', '1.5', '"three"'])('rejects per_hour: %s at load time', (value) => {
    expect(() => loadYamlConfig(writeConfig(`autonomy:\n  relay_budget:\n    per_hour: ${value}\n`)))
      .toThrow(/autonomy.relay_budget.per_hour must be a non-negative integer/);
  });

  it('rejects a relay_budget that is not a mapping', () => {
    expect(() => loadYamlConfig(writeConfig('autonomy:\n  relay_budget: 3\n')))
      .toThrow(/autonomy.relay_budget must be a YAML mapping/);
  });
});
