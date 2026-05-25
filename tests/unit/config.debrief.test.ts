// Tests for debrief config validation in loadYamlConfig().

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-debrief-cfg-'));
  // default.yaml must exist — loadYamlConfig returns {} if absent
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('debrief config validation', () => {
  it('accepts a valid debrief block', () => {
    writeLocalYaml(`
debrief:
  channel: signal
  reminderDelayMinutes: 120
  contextBridgeTtlHours: 48
`);
    const config = loadYamlConfig(tempDir);
    expect(config.debrief).toEqual({
      channel: 'signal',
      reminderDelayMinutes: 120,
      contextBridgeTtlHours: 48,
    });
  });

  it('accepts email as a valid channel', () => {
    writeLocalYaml(`
debrief:
  channel: email
`);
    const config = loadYamlConfig(tempDir);
    expect(config.debrief?.channel).toBe('email');
  });

  it('accepts a debrief block with only some fields', () => {
    writeLocalYaml(`
debrief:
  reminderDelayMinutes: 60
`);
    const config = loadYamlConfig(tempDir);
    expect(config.debrief?.reminderDelayMinutes).toBe(60);
    expect(config.debrief?.channel).toBeUndefined();
  });

  it('rejects invalid channel value', () => {
    writeLocalYaml(`
debrief:
  channel: slack
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief\.channel must be 'signal' or 'email'/,
    );
  });

  it('rejects non-integer reminderDelayMinutes', () => {
    writeLocalYaml(`
debrief:
  reminderDelayMinutes: 1.5
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief\.reminderDelayMinutes must be a positive integer/,
    );
  });

  it('rejects zero reminderDelayMinutes', () => {
    writeLocalYaml(`
debrief:
  reminderDelayMinutes: 0
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief\.reminderDelayMinutes must be a positive integer/,
    );
  });

  it('rejects negative contextBridgeTtlHours', () => {
    writeLocalYaml(`
debrief:
  contextBridgeTtlHours: -1
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief\.contextBridgeTtlHours must be a positive integer/,
    );
  });

  it('rejects non-object debrief value', () => {
    writeLocalYaml(`
debrief: false
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief must be a YAML mapping/,
    );
  });

  it('rejects array debrief value', () => {
    writeLocalYaml(`
debrief:
  - channel: signal
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /debrief must be a YAML mapping/,
    );
  });

  it('passes when debrief block is absent', () => {
    // No debrief block at all — should not throw
    writeLocalYaml('');
    const config = loadYamlConfig(tempDir);
    expect(config.debrief).toBeUndefined();
  });
});
