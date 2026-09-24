import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgentManifests } from '../../../src/agents/loader.js';

describe('discoverAgentManifests', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses valid agent YAML into name + config', () => {
    fs.writeFileSync(path.join(dir, 'cool.yaml'),
      'name: cool\ndescription: a cool agent\nversion: "1.0.0"\nrole: specialist\nmodel:\n  tier: fast\nsystem_prompt: hi\n');
    const found = discoverAgentManifests(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe('cool');
    expect(found[0]!.config?.model.tier).toBe('fast');
    expect(found[0]!.error).toBeUndefined();
  });

  it('captures a YAML parse error instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'busted.yaml'), 'name: busted\n  bad: : indent');
    const found = discoverAgentManifests(dir);
    expect(found[0]!.config).toBeNull();
    expect(found[0]!.error).toBeTruthy();
    expect(found[0]!.name).toBe('busted'); // falls back to filename
  });

  it('captures an invalid agent name instead of throwing (#1882)', () => {
    fs.writeFileSync(
      path.join(dir, 'bad-name.yaml'),
      'name: Bad_Name\ndescription: x\nmodel:\n  tier: fast\nsystem_prompt: hi\n',
    );
    const found = discoverAgentManifests(dir);
    expect(found[0]!.config).toBeNull();
    expect(found[0]!.error).toMatch(/Invalid agent name/);
  });

  it('captures a non-object YAML document without throwing TypeError (#1882)', () => {
    fs.writeFileSync(path.join(dir, 'scalar.yaml'), '42\n');
    const found = discoverAgentManifests(dir);
    expect(found[0]!.config).toBeNull();
    expect(found[0]!.error).toMatch(/Invalid agent name/);
  });
});
