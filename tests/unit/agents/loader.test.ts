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
    // The identity block token is present — system prompt is meaningful.
    expect(config.system_prompt).toContain('${office_identity_block}');
  });

  it('uses office_identity_block token instead of persona fields', () => {
    // Since the identity block migration (issue #139), the coordinator no longer has
    // inline persona fields. Identity is injected at runtime via ${office_identity_block}.
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    // The runtime token is present — will be replaced at startup by OfficeIdentityService.
    expect(config.system_prompt).toContain('${office_identity_block}');
    // No legacy persona tokens remain in the YAML.
    expect(config.system_prompt).not.toContain('${persona.display_name}');
    expect(config.system_prompt).not.toContain('${persona.tone}');
    expect(config.system_prompt).not.toContain('${persona.title}');
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
  model: claude-sonnet-4-6
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

  it('parses schedule entry with agent_id field', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-test-'));
    const yamlContent = `
name: writing-scout
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: "Scout agent"
schedule:
  - cron: "30 8 * * 2"
    agent_id: coordinator
    task: "Run the writing scout"
`;
    const filePath = path.join(tempDir, 'writing-scout.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const config = loadAgentConfig(filePath);
    expect(config.schedule).toHaveLength(1);
    expect(config.schedule![0].agent_id).toBe('coordinator');
    expect(config.schedule![0].cron).toBe('30 8 * * 2');
    expect(config.schedule![0].task).toBe('Run the writing scout');

    fs.rmSync(tempDir, { recursive: true });
  });

  it('schedule entry without agent_id has agent_id undefined', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-test-'));
    const yamlContent = `
name: test-sched
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: "Test"
schedule:
  - cron: "0 9 * * 1"
    task: "weekly task"
`;
    const filePath = path.join(tempDir, 'test-sched.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const config = loadAgentConfig(filePath);
    expect(config.schedule![0].agent_id).toBeUndefined();

    fs.rmSync(tempDir, { recursive: true });
  });
});
