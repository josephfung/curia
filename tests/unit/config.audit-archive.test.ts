import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig } from '../../src/config.js';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-config-'));
  fs.writeFileSync(path.join(dir, 'default.yaml'), content);
  return dir;
}

describe('loadYamlConfig: audit.llmCallArchive.includeReasoning', () => {
  it('accepts a boolean', () => {
    const dir = writeTempConfig(`audit:\n  llmCallArchive:\n    includeReasoning: false\n`);
    expect(loadYamlConfig(dir).audit?.llmCallArchive?.includeReasoning).toBe(false);
  });

  it('rejects a non-boolean', () => {
    const dir = writeTempConfig(`audit:\n  llmCallArchive:\n    includeReasoning: "yes"\n`);
    expect(() => loadYamlConfig(dir)).toThrow('audit.llmCallArchive.includeReasoning');
  });
});
