// Tests for scheduler config validation in loadYamlConfig().

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-scheduler-cfg-'));
  // default.yaml must exist — loadYamlConfig returns {} if absent
  fs.writeFileSync(path.join(tempDir, 'default.yaml'), '');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeLocalYaml(content: string) {
  fs.writeFileSync(path.join(tempDir, 'local.yaml'), content);
}

describe('scheduler config validation', () => {
  it('accepts a positive maxInFlight', () => {
    writeLocalYaml(`
scheduler:
  maxInFlight: 4
`);
    expect(loadYamlConfig(tempDir).scheduler?.maxInFlight).toBe(4);
  });

  it('rejects zero maxInFlight', () => {
    writeLocalYaml(`
scheduler:
  maxInFlight: 0
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /scheduler\.maxInFlight must be a positive integer/,
    );
  });

  it('rejects a fractional maxInFlight', () => {
    writeLocalYaml(`
scheduler:
  maxInFlight: 1.5
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /scheduler\.maxInFlight must be a positive integer/,
    );
  });

  it('rejects a negative maxInFlight', () => {
    writeLocalYaml(`
scheduler:
  maxInFlight: -2
`);
    expect(() => loadYamlConfig(tempDir)).toThrow(
      /scheduler\.maxInFlight must be a positive integer/,
    );
  });
});
