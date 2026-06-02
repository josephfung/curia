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

describe('loadYamlConfig: workingMemory.ttlDays', () => {
  it('accepts a valid positive integer', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 60\n`);
    const config = loadYamlConfig(dir);
    expect(config.workingMemory?.ttlDays).toBe(60);
  });

  it('accepts ttlDays: 1 (minimum)', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 1\n`);
    expect(() => loadYamlConfig(dir)).not.toThrow();
  });

  it('rejects zero', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 0\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory.ttlDays');
  });

  it('rejects a negative value', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: -5\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory.ttlDays');
  });

  it('rejects a non-integer', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 30.5\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory.ttlDays');
  });

  it('is absent when workingMemory block is omitted', () => {
    const dir = writeTempConfig(`skillOutput:\n  maxLength: 100000\n`);
    const config = loadYamlConfig(dir);
    expect(config.workingMemory?.ttlDays).toBeUndefined();
  });

  it('accepts ttlDays: 36500 (maximum)', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 36500\n`);
    expect(() => loadYamlConfig(dir)).not.toThrow();
  });

  it('rejects ttlDays > 36500 to prevent date arithmetic overflow', () => {
    const dir = writeTempConfig(`workingMemory:\n  ttlDays: 36501\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory.ttlDays');
  });

  it('rejects workingMemory: false (non-mapping)', () => {
    const dir = writeTempConfig(`workingMemory: false\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory must be a YAML mapping');
  });

  it('rejects workingMemory: [] (array)', () => {
    const dir = writeTempConfig(`workingMemory: []\n`);
    expect(() => loadYamlConfig(dir)).toThrow('workingMemory must be a YAML mapping');
  });
});
