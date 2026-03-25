import { describe, it, expect } from 'vitest';
import { loadAgentConfig, loadAllAgentConfigs } from '../../../src/agents/loader.js';
import * as path from 'node:path';

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
});
