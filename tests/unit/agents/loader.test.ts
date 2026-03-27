import { describe, it, expect } from 'vitest';
import { loadAgentConfig, loadAllAgentConfigs } from '../../../src/agents/loader.js';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

describe('loadAgentConfig', () => {
  it('loads and parses coordinator.yaml', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    expect(config.name).toBe('coordinator');
    expect(config.role).toBe('coordinator');
    expect(config.model.provider).toBe('anthropic');
    expect(config.system_prompt).toContain('executive assistant');
  });

  it('interpolates persona fields into system_prompt', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    expect(config.system_prompt).toContain('Curia');
    expect(config.system_prompt).not.toContain('${persona.display_name}');
    expect(config.system_prompt).toContain('professional but approachable');
    expect(config.system_prompt).not.toContain('${persona.tone}');
  });

  it('throws on nonexistent file', () => {
    expect(() => loadAgentConfig('/nonexistent/path.yaml')).toThrow('Cannot read agent config');
  });

  it('loads all agent configs from a directory', () => {
    const configs = loadAllAgentConfigs(agentsDir);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    expect(configs.find(c => c.name === 'coordinator')).toBeDefined();
  });

  it('accepts error_budget with max_turns and max_errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-test-'));
    const yamlContent = `
name: test-agent
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
system_prompt: "Test agent"
error_budget:
  max_turns: 10
  max_errors: 3
`;
    const filePath = path.join(tempDir, 'test.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const config = loadAgentConfig(filePath);
    expect(config.error_budget).toEqual({ max_turns: 10, max_errors: 3 });

    fs.rmSync(tempDir, { recursive: true });
  });
});
