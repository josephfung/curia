import { describe, it, expect } from 'vitest';
import { loadYamlConfig } from '../../src/config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A config dir whose local.yaml carries the voice block, as a deployment sets it. */
function writeTempConfig(localYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), 'channels:\n  voice:\n    model: ""\n');
  fs.writeFileSync(path.join(dir, 'local.yaml'), localYaml);
  return dir;
}

// channels.voice.turn_hold_ms is set in config/local.yaml, which is merged but not
// schema-checked, and becomes a setTimeout delay on every spoken turn (#2379).
describe('loadYamlConfig: channels.voice.turn_hold_ms', () => {
  it.each([0, 350, 5000])('accepts %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    turn_hold_ms: ${value}\n`);
    expect(loadYamlConfig(dir).channels?.voice?.turn_hold_ms).toBe(value);
  });

  it.each(['-1', '1.5', '5001', '600000', '"600"'])('rejects %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    turn_hold_ms: ${value}\n`);
    expect(() => loadYamlConfig(dir)).toThrow('channels.voice.turn_hold_ms');
  });
});
