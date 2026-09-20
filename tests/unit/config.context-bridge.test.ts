// Tests for contextBridge config validation in loadYamlConfig().
//
// The per-channel TTL map (#1816) is the knob an operator reaches for when a
// channel's replies routinely arrive after the window closes. A malformed
// value must fail loudly at boot — a silently-ignored override would reproduce
// the original bug (an entry that expired without anyone noticing) while
// looking configured.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-ctxbridge-cfg-'));
  // default.yaml must exist — loadYamlConfig returns {} if absent
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('contextBridge config validation', () => {
  it('accepts a full contextBridge block with per-channel TTLs', () => {
    writeLocalYaml(`
contextBridge:
  defaultExpiryHours: 6
  explicitExpiryHours: 24
  channelDefaultExpiryHours:
    email: 72
    slack: 12
`);
    const config = loadYamlConfig(tempDir);
    expect(config.contextBridge).toEqual({
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      channelDefaultExpiryHours: { email: 72, slack: 12 },
    });
  });

  it('accepts contextBridge without the per-channel map', () => {
    writeLocalYaml(`
contextBridge:
  defaultExpiryHours: 8
`);
    expect(loadYamlConfig(tempDir).contextBridge).toEqual({ defaultExpiryHours: 8 });
  });

  it('rejects a non-integer per-channel TTL, naming the channel', () => {
    writeLocalYaml(`
contextBridge:
  channelDefaultExpiryHours:
    email: 1.5
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /contextBridge\.channelDefaultExpiryHours\.email must be a positive integer/,
    );
  });

  it('rejects a zero or negative per-channel TTL', () => {
    writeLocalYaml(`
contextBridge:
  channelDefaultExpiryHours:
    signal: 0
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /contextBridge\.channelDefaultExpiryHours\.signal must be a positive integer/,
    );
  });

  it('rejects a non-numeric per-channel TTL', () => {
    writeLocalYaml(`
contextBridge:
  channelDefaultExpiryHours:
    email: "three days"
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /contextBridge\.channelDefaultExpiryHours\.email must be a positive integer/,
    );
  });

  it('rejects a list where a channel-to-hours mapping is expected', () => {
    writeLocalYaml(`
contextBridge:
  channelDefaultExpiryHours:
    - email
    - 72
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /contextBridge\.channelDefaultExpiryHours must be a YAML mapping/,
    );
  });

  it('still rejects a negative defaultExpiryHours', () => {
    writeLocalYaml(`
contextBridge:
  defaultExpiryHours: -1
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /contextBridge\.defaultExpiryHours must be a positive integer/,
    );
  });
});
