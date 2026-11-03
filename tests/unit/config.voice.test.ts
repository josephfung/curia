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

// Onset barge-in knobs (#2401), set the same way.
describe('loadYamlConfig: channels.voice barge-in on speech start', () => {
  it.each(['true', 'false'])('accepts barge_in_on_speech_start: %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    barge_in_on_speech_start: ${value}\n`);
    expect(loadYamlConfig(dir).channels?.voice?.barge_in_on_speech_start).toBe(value === 'true');
  });

  it.each(['"false"', '0', 'yes-please'])('rejects barge_in_on_speech_start: %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    barge_in_on_speech_start: ${value}\n`);
    expect(() => loadYamlConfig(dir)).toThrow('channels.voice.barge_in_on_speech_start');
  });

  it.each([-90, -35, -20.5, 0])('accepts barge_in_speech_start_min_dbfs: %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    barge_in_speech_start_min_dbfs: ${value}\n`);
    expect(loadYamlConfig(dir).channels?.voice?.barge_in_speech_start_min_dbfs).toBe(value);
  });

  it.each(['-91', '3', '"-35"', '.nan'])('rejects barge_in_speech_start_min_dbfs: %s', (value) => {
    const dir = writeTempConfig(`channels:\n  voice:\n    barge_in_speech_start_min_dbfs: ${value}\n`);
    expect(() => loadYamlConfig(dir)).toThrow('channels.voice.barge_in_speech_start_min_dbfs');
  });
});
