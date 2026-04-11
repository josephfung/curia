import { describe, it, expect } from 'vitest';
import { loadYamlConfig } from './config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), content);
  return dir;
}

describe('loadYamlConfig: dreaming block', () => {
  it('accepts valid dreaming.decay config', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    intervalMs: 86400000
    archiveThreshold: 0.05
    halfLifeDays:
      permanent: null
      slow_decay: 180
      fast_decay: 21
`);
    const config = loadYamlConfig(dir);
    expect(config.dreaming?.decay?.intervalMs).toBe(86400000);
    expect(config.dreaming?.decay?.archiveThreshold).toBe(0.05);
    expect(config.dreaming?.decay?.halfLifeDays?.slow_decay).toBe(180);
    expect(config.dreaming?.decay?.halfLifeDays?.permanent).toBeNull();
  });

  it('rejects intervalMs that is not a positive integer', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    intervalMs: -1
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.intervalMs');
  });

  it('rejects archiveThreshold outside 0-1', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    archiveThreshold: 1.5
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.archiveThreshold');
  });

  it('rejects non-positive halfLifeDays', () => {
    const dir = writeTempConfig(`
dreaming:
  decay:
    halfLifeDays:
      slow_decay: 0
`);
    expect(() => loadYamlConfig(dir)).toThrow('dreaming.decay.halfLifeDays.slow_decay');
  });

  it('accepts absent dreaming block (uses defaults)', () => {
    const dir = writeTempConfig('agents: {}');
    const config = loadYamlConfig(dir);
    expect(config.dreaming).toBeUndefined();
  });
});
