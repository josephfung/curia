import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';
import type { SkillManifest, SkillHandler } from '../../../src/skills/types.js';

const stubHandler: SkillHandler = {
  execute: async () => ({ success: true, data: 'stub' }),
};

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    description: 'A test skill',
    version: '1.0.0',
    sensitivity: 'normal',
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 30000,
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('registers and retrieves a skill by name', () => {
    const manifest = makeManifest({ name: 'my-skill' });
    registry.register(manifest, stubHandler);
    const skill = registry.get('my-skill');
    expect(skill).toBeDefined();
    expect(skill!.manifest.name).toBe('my-skill');
  });

  it('returns undefined for unknown skill', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered skills', () => {
    registry.register(makeManifest({ name: 'a' }), stubHandler);
    registry.register(makeManifest({ name: 'b' }), stubHandler);
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.manifest.name)).toEqual(['a', 'b']);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeManifest({ name: 'dup' }), stubHandler);
    expect(() => registry.register(makeManifest({ name: 'dup' }), stubHandler))
      .toThrow(/already registered/);
  });

  it('searches skills by description keyword', () => {
    registry.register(makeManifest({ name: 'email-parser', description: 'Parse emails from IMAP' }), stubHandler);
    registry.register(makeManifest({ name: 'web-fetch', description: 'Fetch web pages via HTTP' }), stubHandler);
    const results = registry.search('email');
    expect(results).toHaveLength(1);
    expect(results[0].manifest.name).toBe('email-parser');
  });

  it('search is case-insensitive', () => {
    registry.register(makeManifest({ name: 'web-fetch', description: 'Fetch web pages via HTTP GET' }), stubHandler);
    const results = registry.search('HTTP');
    expect(results).toHaveLength(1);
  });

  it('converts registered skills to LLM tool definitions', () => {
    registry.register(makeManifest({
      name: 'web-fetch',
      description: 'Fetch a web page',
      inputs: { url: 'string', max_length: 'number?' },
    }), stubHandler);
    const tools = registry.toToolDefinitions(['web-fetch']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('web-fetch');
    expect(tools[0].description).toBe('Fetch a web page');
    expect(tools[0].input_schema.properties).toHaveProperty('url');
    expect(tools[0].input_schema.properties).toHaveProperty('max_length');
  });

  it('toToolDefinitions ignores unknown skill names', () => {
    const tools = registry.toToolDefinitions(['nonexistent']);
    expect(tools).toHaveLength(0);
  });
});
