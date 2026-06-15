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

// The browser block can be overridden via config/local.yaml, which is deep-merged but not
// schema-validated — so loadYamlConfig() rejects malformed values explicitly. A bad
// sweepIntervalMs (0/-1) would otherwise reach BrowserService and schedule runaway sweeps.
describe('loadYamlConfig: browser block validation', () => {
  it('accepts a valid browser block', () => {
    const dir = writeTempConfig(
      `browser:\n  sessionTtlMs: 600000\n  sweepIntervalMs: 120000\n  profileDir: "/data/profile"\n  channel: chrome\n  locale: en-US\n`,
    );
    const config = loadYamlConfig(dir);
    expect(config.browser?.channel).toBe('chrome');
    expect(config.browser?.sweepIntervalMs).toBe(120000);
  });

  it('rejects sweepIntervalMs: 0', () => {
    const dir = writeTempConfig(`browser:\n  sweepIntervalMs: 0\n`);
    expect(() => loadYamlConfig(dir)).toThrow('browser.sweepIntervalMs');
  });

  it('rejects a negative sessionTtlMs', () => {
    const dir = writeTempConfig(`browser:\n  sessionTtlMs: -1\n`);
    expect(() => loadYamlConfig(dir)).toThrow('browser.sessionTtlMs');
  });

  it('rejects a non-integer sweepIntervalMs', () => {
    const dir = writeTempConfig(`browser:\n  sweepIntervalMs: 1.5\n`);
    expect(() => loadYamlConfig(dir)).toThrow('browser.sweepIntervalMs');
  });

  it('rejects a non-string channel', () => {
    const dir = writeTempConfig(`browser:\n  channel: 123\n`);
    expect(() => loadYamlConfig(dir)).toThrow('browser.channel');
  });
});
